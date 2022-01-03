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

const listener = app.listen(process.env.PORT, function() {
    console.log(`MyHistoryDosis is running on port ${listener.address().port}`);

    const twitterClient = new Twit({
        consumer_key: process.env.TWITTER_CONSUMER_KEY,
        consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
        access_token: process.env.TWITTER_ACCESS_TOKEN,
        access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
    });

    const EVERY_TEN_MINUTES = '*/10 * * * *';
    const EVERY_HOUR = '0 * * * *';

    // fetch reddit posts
    (new CronJob(EVERY_TEN_MINUTES, async () => {
        const postedTweets = await getPostedTweets();

        const randomSubreddit = Math.floor(Math.random() * Math.floor(subreddits.length));

        request('https://old.reddit.com/r/' + subreddits[randomSubreddit], function(err, res, body) {
            if (err) {
                console.log('Error at fetching reddit post: ', err);
            } else {
                let $ = cheerio.load(body);
                // get all titles in the subredit reddit page
                $('p.title a.title').each(function() {
                    const post = $(this)[0].children[0];
                    const postHash = hash(post.data, 'crc32');
                    // make sure the post is not on the "to tweet" list and has not been tweeted.
                    if (!redditPosts.some(e => e.hash === postHash) && !postedTweets.has(postHash)) {
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
                    }
                });
            }
        });
    })).start();

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
                                markPostAsTweeted(redditPost.hash);
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

const IMG_DIR = process.env.IMG_DIR;
const POSTED_IMG_DIR = process.env.POSTED_IMG_DIR;

const fetchRedditImage = async (redditPost) => {
    request(redditPost.imageUrl, (err, res, body) => {
        if (err) {
            console.log('Error at fetching reddit image: ', err);
        } else {
            console.log(`Trying to fetch image for reddit post: ${redditPost.status}`);
            // get all url links in the reddit post page
            let $ = cheerio.load(body);
            $('a').each(function() {
                let text = $(this).text();
                let link = $(this).attr('href');

                // download reddit image locally
                if (link && link.match(/(https:\/\/i.redd.it\/)(\w+)(.jpg|.png)/)) {
                    request.get(link, (err, res, body) => {
                        request(link)
                            .pipe(fs.createWriteStream(`${IMG_DIR}${redditPost.hash}.jpg`))
                            .on('close', () => {
                                redditPost.localImage = `${IMG_DIR}${redditPost.hash}.jpg`;
                                redditPosts.push(redditPost);
                                console.info(JSON.stringify(redditPost));
                            });
                    });
                }
            });
        }
    });
}

/**
 * Set of strings containing the hash of the posted tweets
 * @returns Set of strings
 */
 const getPostedTweets = async () => {
    const latestPostedTweets = new Set();
    fs.readdir(POSTED_IMG_DIR, (err, files) => {
        files.forEach(file => {
            latestPostedTweets.add(file.split(".")[0]);
        });
    });
    return latestPostedTweets;    
};

/**
 * Adds an image that has been tweeted to the "tweeted" image repository
 * @param {string} postHash 
 */
 const markPostAsTweeted = async (postHash) => {
    move(`${IMG_DIR}${postHash}.jpg`, `${POSTED_IMG_DIR}${postHash}.jpg`, (cb) => {})
};

/**
 * Renames, if possible, or falls back to copying
 * @param {string} oldPath source path
 * @param {string} newPath destination path
 * @param {*} callback 
 */
const move = async (oldPath, newPath, callback) => {
    fs.rename(oldPath, newPath, (err) => {
        if (err) {
            if (err.code === 'EXDEV') {
                copy();
            } else {
                callback(err);
            }
            return;
        }
        callback();
    });

    const copy = () => {
        const readStream = fs.createReadStream(oldPath);
        const writeStream = fs.createWriteStream(newPath);

        readStream.on('error', callback);
        writeStream.on('error', callback);

        readStream.on('close', function () {
            fs.unlink(oldPath, callback);
        });

        readStream.pipe(writeStream);
    };
};
