'use strict';

require('dotenv').config();
const fs = require('fs');
const express = require('express');
const app = express();
const request = require('request');
const cheerio = require('cheerio');
const CronJob = require('cron').CronJob;
const ObjectsToCsv = require('objects-to-csv');
const Twit = require('twit');
const { hash } = require('./hash');

app.use(express.static('public'));

const subreddits = ['ColorizedHistory', 'OldPhotosInRealLife', 'HistoryPorn', 'OldSchoolCool', 'RetroFuturism', 'TrippinThroughTime', 'Lost_Architecture'];
const redditPosts = [];
const postedTweets = new Set();

const seedRedditPosts = () => {
    const csvList = fs.readFileSync('tweets.csv')
        .toString()
        .split('\n')
        .map(e => e.trim())
        .map(e => e.split(',').map(e => e.trim())); // split each line to array

    const headers = csvList[0];
    const rows = csvList.slice(1);
    rows.forEach((row) => {
        let post = {};
        headers.forEach((headers, i) => post[headers] = row[i]);
        redditPosts.push(post);
    });
    
    // replace $COMMA$ by an actual comma
    for (let i = 0; i < redditPosts.length; i++) {
        redditPosts[i].status = redditPosts[i].status.split("$COMMA$").join(",");
    }
};

const seedPostedTweets = () => {
    const csvList = fs.readFileSync('tweeted.csv')
        .toString()
        .split('\n')
        .map(e => e.trim())
        .map(e => e.split(',').map(e => e.trim())); // split each line to array

    const headers = csvList[0];
    const rows = csvList.slice(1);
    
    rows.map(hash => postedTweets.add(hash));
};

const listener = app.listen(process.env.PORT, function() {
    console.log('MyHistoryDosis is running on port ' + listener.address().port);
    seedRedditPosts();
    seedPostedTweets();

    const twitterClient = new Twit({
        consumer_key: process.env.TWITTER_CONSUMER_KEY,
        consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
        access_token: process.env.TWITTER_ACCESS_TOKEN,
        access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
    });

    const EVERY_TEN_MINUTES = '*/10 * * * *';
    const EVERY_HOUR = '0 * * * *';
    const IMG_DIR = 'E:\\img\\';

    // fetch reddit posts
    (new CronJob(EVERY_TEN_MINUTES, function() {
        const randomSubreddit = Math.floor(Math.random() * Math.floor(subreddits.length));
        request('https://old.reddit.com/r/' + subreddits[randomSubreddit], function(err, res, body) {
            if (err) {
                console.log('Error at fetching reddit: ', err);
            } else {
                // get all titles in the subredit reddit page
                let $ = cheerio.load(body);
                $('p.title a.title').each(function() {

                    const post = $(this)[0].children[0];
                    const postHash = hash(post.data, 'crc32');

                    // make sure the post is not on the "to tweet" list and has not been tweeted.
                    if (!redditPosts.some(e => e.hash === postHash) && !postedTweets.has(postHash)) {
                        console.log('Fetched reddit post: ' + post.data);
                        // get the URL to the reddit post
                        let url = post.parent.attribs['href'];
                        // if the URL is an imagur link discard it.
                        // TODO: improve url matching
                        if (!url.includes("http")) {
                            let postDraft = {
                                'status': post.data,
                                'hash': postHash,
                                'imageUrl': 'https://www.reddit.com' + url,
                            }
                            fetchRedditImage(postDraft)
                        }
                        postedTweets.add(postHash); //discard
                    }
                });
            }
        });
    })).start();

    const fetchRedditImage = async (redditPost) => {
        request(redditPost.imageUrl, (err, res, body) => {
            if (err) {
                console.log('Error at fetching reddit: ', err);
            } else {
                // get all url links in the reddit post page
                let $ = cheerio.load(body);
                $('a').each(function() {
                    let text = $(this).text();
                    let link = $(this).attr('href');

                    // grab the reddit image and download it locally
                    if (link && link.match(/(https:\/\/i.redd.it\/)(\w+)(.jpg|.png)/)) {
                        console.log('Fetching image for reddit post: ' + redditPost.status);
                        request.get(link, (err, res, body) => {
                            request(link)
                                .pipe(fs.createWriteStream(IMG_DIR + redditPost.hash + '.jpg'))
                                .on('close', () => {
                                    redditPost.localImage = IMG_DIR + redditPost.hash + '.jpg';
                                    redditPosts.push(redditPost);
                                    console.log('Fetched image for reddit post: ' + redditPost.localImage);
                                });
                        });
                    } else {
                        postedTweets.add(redditPost.hash); //discard
                    };
                });
            }
        });
    }

    // tweet
    (new CronJob(EVERY_HOUR, function() {
        if (redditPosts.length > 0) {
            const randomNumber = Math.floor(Math.random() * redditPosts.length);
            const redditPost = redditPosts[randomNumber];
            redditPosts.splice(randomNumber, 1);

            let tweet = redditPost.status;

            // make sure tweet is less than 280 characters
            if (tweet.length > 280) {
                const textToRemove = tweet.length - 280 + 5;
                tweet = redditPost.status.substring(0, redditPost.status.length - textToRemove) + '... ';
            }

            if (redditPost.localImage) {
                const b64content = fs.readFileSync(redditPost.localImage, { encoding: 'base64' });
                twitterClient.post('media/upload', { media_data: b64content }, function(err, data, response) {
                    const mediaIdStr = data.media_id_string;
                    const altText = tweet;
                    const meta_params = { media_id: mediaIdStr, alt_text: { text: altText } };
    
                    twitterClient.post('media/metadata/create', meta_params, function(err, data, response) {
                        if (!err) {
                            // now we can reference the media and post a tweet (media will attach to the tweet)
                            const params = { status: tweet, media_ids: [mediaIdStr] };
    
                            twitterClient.post('statuses/update', params, function(err, data, response) {
                                console.log('Tweeted', `https://twitter.com/${data.user.screen_name}/status/${data.id_str}`);
                                postedTweets.add(redditPost.hash); //discard
                            });
                        }
                    });
                });
            } 
        } else {
            console.log('Reddit posts not fetched yet.');
        }
    })).start();

    // backup tweets
    (new CronJob(EVERY_TEN_MINUTES, function() {
        // convert set to array of objects
        const backupPostedTweets = [];
        postedTweets.forEach(function(hash) {
            backupPostedTweets.push({hash});
        });

        // remove commas from the status for better csv parsing
        const backupRedditPosts = redditPosts.map(post => {
            post.status = post.status.split(",").join("$COMMA$");
            return post;
        });

        // backup arrays
        new ObjectsToCsv(backupRedditPosts).toDisk('./tweets.csv');
        new ObjectsToCsv(backupPostedTweets).toDisk('./tweeted.csv');
    })).start();
});
