'use strict';

require('dotenv').config();
const fs = require('fs');
const express = require('express');
const app = express();
const request = require('request');
const cheerio = require('cheerio');
const CronJob = require('cron').CronJob;
const Twit = require('twit');
const {
    hash
} = require('./hash');

app.use(express.static('public'));

const BACKUP_FILE = process.env.BACKUP_FILE;
const loadBackup = (path) => {
    try {
        return fs.readFileSync(path, 'utf8')
    } catch (err) {
        console.error(err)
        return false
    }
}
const subreddits = ['ColorizedHistory', 'OldPhotosInRealLife', 'HistoryPorn', 'OldSchoolCool', 'RetroFuturism', 'TrippinThroughTime', 'Lost_Architecture'];
const redditPosts = JSON.parse(loadBackup(BACKUP_FILE));

const twitterClient = new Twit({
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    access_token: process.env.TWITTER_ACCESS_TOKEN,
    access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
});

const listener = app.listen(process.env.PORT, function() {
    console.log(`MyHistoryDosis is running on port ${listener.address().port}`);

    // fetch reddit posts
    (new CronJob('*/10 * * * *', async () => {
        const postedTweets = await getPostedTweetsSet();

        const randomSubreddit = Math.floor(Math.random() * Math.floor(subreddits.length));

        // fetch a random subreddit page
        request('https://old.reddit.com/r/' + subreddits[randomSubreddit], function(err, res, body) {
            if (err) {
                console.error(`Error at fetching subreddit: ${randomSubreddit} `, err);
            } else {
                let $ = cheerio.load(body);
                // get all the posts' titles and links
                $('p.title a.title').each(function() {
                    const postTitle = $(this)[0].children[0];
                    const postUrl = sanitizeRedditImageUrl($(this)[0].attribs.href);
                    const postHash = hash(postTitle.data, 'crc32');

                    // make sure the url is an image and that the post has not been fetched or tweeted yet.
                    if (postUrl != "" && !redditPosts.some(e => e.hash === postHash) && !postedTweets.has(postHash)) {
                        let postDraft = {
                            'status': postTitle.data,
                            'hash': postHash,
                            'imageUrl': postUrl
                        }
                        fetchRedditImage(postDraft)
                    }
                });
            }
        });
    })).start();

    // tweet
    (new CronJob('0 * * * *', function() {
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
                const b64content = fs.readFileSync(redditPost.localImage, {
                    encoding: 'base64'
                });
                twitterClient.post('media/upload', {
                    media_data: b64content
                }, function(err, data, response) {
                    const mediaIdStr = data.media_id_string;
                    const altText = tweet;
                    const meta_params = { media_id: mediaIdStr, alt_text: { text: altText } };

                    twitterClient.post('media/metadata/create', meta_params, function(err, data, response) {
                        if (!err) {
                            // now we can reference the media and post a tweet (media will attach to the tweet)
                            const params = { status: tweet, media_ids: [mediaIdStr] };
                            twitterClient.post('statuses/update', params, function(err, data, response) {
                                console.log('Tweeted', `https://twitter.com/${data.user.screen_name}/status/${data.id_str}`);
                                moveImageToTweetedDirectory(redditPost.hash);
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
    // the reddit post could either be an image or a reddit page.
    // if it's an image, download it directly
    // else find the url of the image and then go to the url to download the image
    if (redditPost.imageUrl.endsWith("jpg") || redditPost.imageUrl.endsWith(".png")) {
        request.get(redditPost.imageUrl, (err, res, body) => {
            request(redditPost.imageUrl)
                .pipe(fs.createWriteStream(`${IMG_DIR}${redditPost.hash}.jpg`))
                .on('close', () => {
                    redditPost.localImage = `${IMG_DIR}${redditPost.hash}.jpg`;
                    redditPosts.push(redditPost);
                    console.log(`Successfully fetched image for reddit post: ${redditPost.status}`);
                });
        });
    } else {
        request(redditPost.imageUrl, (err, res, body) => {
            if (err) {
                console.log('Error at fetching reddit image: ', err);
            } else {
                let $ = cheerio.load(body);
                $('a').each(function() {
                    let link = $(this).attr('href');

                    // download reddit image locally
                    if (link && link.match(/(https:\/\/i.redd.it\/)(\w+)(.jpg|.png)/)) {
                        request.get(link, (err, res, body) => {
                            request(link)
                                .pipe(fs.createWriteStream(`${IMG_DIR}${redditPost.hash}.jpg`))
                                .on('close', () => {
                                    redditPost.localImage = `${IMG_DIR}${redditPost.hash}.jpg`;
                                    redditPosts.push(redditPost);
                                    console.log(`Successfully fetched image for reddit post: ${redditPost.status}`);
                                });
                        });
                    }
                });
            }
            storeBackup(redditPosts, BACKUP_FILE);
        });
    }
}

const sanitizeRedditImageUrl = (imageUrl) => {
    if (imageUrl.endsWith(".jpg") || imageUrl.endsWith(".png"))
        return imageUrl;
    else if (imageUrl.startsWith("/r/"))
        return `https://old.reddit.com${imageUrl}`;
    else if (imageUrl.includes("https://v.reddit.it"))
        return imageUrl
    else
        return ""
};

const getPostedTweetsSet = async () => {
    const latestPostedTweets = new Set();
    fs.readdir(POSTED_IMG_DIR, (err, files) => {
        files.forEach(file => {
            latestPostedTweets.add(file.split(".")[0]);
        });
    });
    return latestPostedTweets;
};

const storeBackup = async (data, path) => {
    try {
        fs.writeFileSync(path, JSON.stringify(data))
    } catch (err) {
        console.error(err)
    }
};

const moveImageToTweetedDirectory = async (postHash) => {
    move(`${IMG_DIR}${postHash}.jpg`, `${POSTED_IMG_DIR}${postHash}.jpg`, (cb) => {})
};

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

        readStream.on('close', function() {
            fs.unlink(oldPath, callback);
        });

        readStream.pipe(writeStream);
    };
};
