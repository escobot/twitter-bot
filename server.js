'use strict';

require('dotenv').config();
const fs = require('fs');
const express = require('express');
const app = express();
const request = require('request');
const cheerio = require('cheerio');
const CronJob = require('cron').CronJob;
const Twit = require('twit');
const { hash } = require('./hash');

app.use(express.static('public'));

const subreddits = ['ColorizedHistory', 'OldPhotosInRealLife', 'HistoryPorn', 'OldSchoolCool', 'RetroFuturism', 'TrippinThroughTime', 'Lost_Architecture'];
const redditPosts = [];
const postedTweets = [];

const listener = app.listen(process.env.PORT, function() {
    console.log('MyHistoryDosis is running on port ' + listener.address().port);

    const twitterClient = new Twit({
        consumer_key: process.env.TWITTER_CONSUMER_KEY,
        consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
        access_token: process.env.TWITTER_ACCESS_TOKEN,
        access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
    });

    const EVERY_MINUTE = '* * * * *';
    const EVERY_HOUR = '0 * * * *';

    // fetch reddit posts
    (new CronJob(EVERY_MINUTE, function() {
        const randomSubreddit = Math.floor(Math.random() * Math.floor(subreddits.length));
        request('https://old.reddit.com/r/' + subreddits[randomSubreddit], function(err, res, body) {
            if (err) {
                console.log('Error at fetching reddit: ', err);
            } else {
                let $ = cheerio.load(body);
                $('p.title a.title').each(function() {
                    // make sure the post is not on the "to tweet" list and has not been tweeted.
                    const post = $(this)[0].children[0];
                    const postHash = hash(post.data, 'crc32');
                    if (!redditPosts.some(e => e.hash === postHash) && !postedTweets.some(e => e.hash === postHash)) {
                        console.log('Fetched reddit post: ' + post.data);
                        let url = post.parent.attribs['href'];
                        // if the URL is an imagur link discard it.
                        // TODO: improve url matching
                        if (!url.includes("http")) {
                            let postDraft = {
                                'status': post.data,
                                'hash': postHash,
                                'imageUrl': 'https://www.reddit.com' + url,
                            }
                            fetchImage(postDraft)
                        }
                        postedTweets.push({ 'hash': postHash }); //discard
                    }
                });
            }
        });
    })).start();

    const fetchImage = async (redditPost) => {
        request(redditPost.imageUrl, (err, res, body) => {
            if (err) {
                console.log('Error at fetching reddit: ', err);
            } else {
                let $ = cheerio.load(body);
                $('a').each(function() {
                    let text = $(this).text();
                    let link = $(this).attr('href');

                    if (link && link.match(/(https:\/\/i.redd.it\/)(\w+)(.jpg|.png)/)) {
                        console.log('Fetching image for reddit post: ' + redditPost.status);
                        request.get(link, (err, res, body) => {
                            request(link)
                                .pipe(fs.createWriteStream('E:\\img\\' + redditPost.hash + '.jpg'))
                                .on('close', () => {
                                    // TODO: constant for img location
                                    redditPost.localImage = 'E:\\img\\' + redditPost.hash + '.jpg';
                                    redditPosts.push(redditPost);
                                    console.log('Fetched image for reddit post: ' + redditPost.localImage);
                                })
                        })
                    } else {
                        postedTweets.push({ 'hash': redditPost.hash }); //discard
                    };
                });
            }
        });
    }

    // tweet
    (new CronJob(EVERY_HOUR, function() {
        if (redditPosts.length > 0) {
            const random = Math.floor(Math.random() * redditPosts.length);
            const redditPost = redditPosts[random];
            redditPosts.splice(random, 1);

            let tweet = redditPost.status;

            // make sure tweet is less than 280 characters
            if (tweet.length > 280) {
                const toRemove = tweet.length - 280 + 5;
                tweet = redditPost.status.substring(0, redditPost.status.length - toRemove) + '... ';
            }

            if (redditPost.localImage) {
                let b64content = fs.readFileSync(redditPost.localImage, { encoding: 'base64' });
                twitterClient.post('media/upload', { media_data: b64content }, function(err, data, response) {
                    let mediaIdStr = data.media_id_string;
                    let altText = tweet;
                    let meta_params = { media_id: mediaIdStr, alt_text: { text: altText } };
    
                    twitterClient.post('media/metadata/create', meta_params, function(err, data, response) {
                        if (!err) {
                            // now we can reference the media and post a tweet (media will attach to the tweet)
                            let params = { status: tweet, media_ids: [mediaIdStr] };
    
                            twitterClient.post('statuses/update', params, function(err, data, response) {
                                console.log('Tweeted', `https://twitter.com/${data.user.screen_name}/status/${data.id_str}`);
                                postedTweets.push({ 'hash': redditPost.hash }); //discard
                            });
                        }
                    });
                });
            } 
        } else {
            console.log('Reddit posts not fetched yet.');
        }
    })).start();
});
