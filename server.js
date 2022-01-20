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

const getTwitterClients = (NUMBER_OF_CLIENTS) => {
    const loadBackup = (path) => {
        try {
            return fs.readFileSync(path, 'utf8')
        } catch (err) {
            console.error(err)
            return false
        }
    };
    const twitterClients = [];
    for(let i = 1; i <= NUMBER_OF_CLIENTS; i++) {
        const backupFile = process.env['BACKUP_FILE_' + i];
        const isBackedUp = loadBackup(backupFile);
        const imageDirectory = process.env['IMG_DIR_' + i];
        const subreddits = JSON.parse(process.env['SUBREDDITS_' + i]);
        const twitterClient = new Twit({
            consumer_key: process.env['TWITTER_CONSUMER_KEY_' + i],
            consumer_secret: process.env['TWITTER_CONSUMER_SECRET_' + i],
            access_token: process.env['TWITTER_ACCESS_TOKEN_' + i],
            access_token_secret: process.env['TWITTER_ACCESS_TOKEN_SECRET_' + i]
        });
        const redditPosts = isBackedUp ? JSON.parse(loadBackup(backupFile)) : [];
        twitterClients.push({ imageDirectory, backupFile, redditPosts, subreddits, twitterClient });
    }
    return twitterClients;
};

const POSTED_IMG_DIR = process.env.POSTED_IMG_DIR;

const NUMBER_OF_CLIENTS = 9;
const twitterClients = getTwitterClients(NUMBER_OF_CLIENTS);
let SUBREDDIT_RR = -1;

const fetchRedditPosts = async (twitterClientIndex) => {
    const postedTweets = await getPostedTweetsSet();
    const randomSubreddit = SUBREDDIT_RR % twitterClients[twitterClientIndex].subreddits.length;

    // fetch a random subreddit page
    request('https://old.reddit.com/r/' + twitterClients[twitterClientIndex].subreddits[randomSubreddit], function(err, res, body) {
        if (err) {
            console.error(`Error at fetching subreddit: ${randomSubreddit} `, err);
        } else {
            let $ = cheerio.load(body);
            $('div.top-matter').each(function() {
                const postTitle = $(this).find('p.title a.title').text();
                const postUrl = sanitizeRedditImageUrl($(this).find('p.title a.title').attr('href'));
                const postAuthor = $(this).find('p.tagline a.author').text();
                const postHash = hash(postTitle, 'crc32');

                if (postUrl != "" && !twitterClients[twitterClientIndex].redditPosts.some(e => e.hash === postHash) && !postedTweets.has(postHash)) {
                    let postDraft = {
                        'status': postTitle,
                        'hash': postHash,
                        'imageUrl': postUrl,
                        'author': postAuthor,
                        'subReddit': twitterClients[twitterClientIndex].subreddits[randomSubreddit]
                    }
                    fetchRedditImage(twitterClientIndex, postDraft);
                }
            });
        }
    });
};

const tweet = async (twitterClientIndex) => {
    if (twitterClients[twitterClientIndex].redditPosts.length > 0) {
        const randomNumber = Math.floor(Math.random() * twitterClients[twitterClientIndex].redditPosts.length);
        const redditPost = twitterClients[twitterClientIndex].redditPosts[randomNumber];
        twitterClients[twitterClientIndex].redditPosts.splice(randomNumber, 1);

        const credits = redditPost.author ? ` (${redditPost.author})` : '';
        const subRedditName = redditPost.subReddit ? ` #${redditPost.subReddit}` : '';

        let tweet = `${redditPost.status}${credits}${subRedditName}`;
        // make sure tweet is less than 280 characters
        if (tweet.length > 280) {
            const textToRemove = tweet.length - 280 + 5;
            tweet = redditPost.status.substring(0, redditPost.status.length - textToRemove) + '... ';
        }

        if (redditPost.localImage) {
            const b64content = fs.readFileSync(redditPost.localImage, {
                encoding: 'base64'
            });
            twitterClients[twitterClientIndex].twitterClient.post('media/upload', {
                media_data: b64content
            }, function(err, data, response) {
                const mediaIdStr = data.media_id_string;
                const altText = tweet;
                const meta_params = { media_id: mediaIdStr, alt_text: { text: altText } };

                twitterClients[twitterClientIndex].twitterClient.post('media/metadata/create', meta_params, function(err, data, response) {
                    if (!err) {
                        // now we can reference the media and post a tweet (media will attach to the tweet)
                        const params = { status: tweet, media_ids: [mediaIdStr] };
                        twitterClients[twitterClientIndex].twitterClient.post('statuses/update', params, function(err, data, response) {
                            if (err) {
                                console.error(`Error at tweeting for subReddit: ${twitterClientIndex} `, err);
                            } else {
                                console.log('Tweeted', `https://twitter.com/${data.user.screen_name}/status/${data.id_str}`);
                                moveImageToTweetedDirectory(twitterClientIndex, redditPost.hash);
                            }
                        });
                    }
                });
            });
        }
    } else {
        console.log('Reddit posts not fetched yet.');
    }
};

const fetchRedditImage = async (twitterClientIndex, redditPost) => {
    if (redditPost.imageUrl.endsWith("jpg") || redditPost.imageUrl.endsWith(".png")) {
        request.get(encodeURI(redditPost.imageUrl), (err, res, body) => {
            if (err) {
                console.error(`Error at downloading image (if): ${redditPost.status} `, err);
                removeTweetFromList(redditPost.hash);
            } else {
            request(encodeURI(redditPost.imageUrl))
                .pipe(fs.createWriteStream(`${twitterClients[twitterClientIndex].imageDirectory}${redditPost.hash}.jpg`))
                .on('close', () => {
                    redditPost.localImage = `${twitterClients[twitterClientIndex].imageDirectory}${redditPost.hash}.jpg`;
                    twitterClients[twitterClientIndex].redditPosts.push(redditPost);
                    console.log(`Successfully fetched image for reddit post: ${redditPost.status}`);
                });
            }
        });
    } else {
        request(encodeURI(redditPost.imageUrl), (err, res, body) => {
            if (err) {
                console.error(`Error at downloading image (else): ${redditPost.status} `, err);
                removeTweetFromList(redditPost.hash);
            } else {
                let $ = cheerio.load(body);
                $('a').each(function() {
                    let link = $(this).attr('href');

                    // download reddit image locally
                    if (link && link.match(/(https:\/\/i.redd.it\/)(\w+)(.jpg|.png)/)) {
                        request.get(link, (err, res, body) => {
                            request(link)
                                .pipe(fs.createWriteStream(`${twitterClients[twitterClientIndex].imageDirectory}${redditPost.hash}.jpg`))
                                .on('close', () => {
                                    redditPost.localImage = `${twitterClients[twitterClientIndex].imageDirectory}${redditPost.hash}.jpg`;
                                    twitterClients[twitterClientIndex].redditPosts.push(redditPost);
                                    console.log(`Successfully fetched image for reddit post: ${redditPost.status}`);
                                });
                        });
                    }
                });
            }
        });
    }
    storeBackup(twitterClients[twitterClientIndex].redditPosts, twitterClients[twitterClientIndex].backupFile);
}

const removeTweetFromList = (tweetHash) => {
    for(let j = 0; j < NUMBER_OF_CLIENTS; j++) {
        for(var i = 0; i < twitterClients[j].redditPosts.length; i++) {
            if(twitterClients[j].redditPosts[i].hash == tweetHash) {
                redditPosts.splice(i, 1);
                break;
            }
        }
    }
};

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

const moveImageToTweetedDirectory = async (twitterClientIndex, postHash) => {
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
    move(`${twitterClients[twitterClientIndex].imageDirectory}${postHash}.jpg`, `${POSTED_IMG_DIR}${postHash}.jpg`, (cb) => {})
};

const listener = app.listen(process.env.PORT, function() {
    console.log(`Twitter bot is running on port ${listener.address().port}`);

    // fetch reddit posts
    (new CronJob('0 * * * *', () => {
        for(let i = 0; i < NUMBER_OF_CLIENTS; i++) {
            SUBREDDIT_RR++;
            fetchRedditPosts(i);
        }
    })).start();

    // tweet
    (new CronJob('0 */2 * * *', () => {
        for(let i = 0; i < 2; i++) {
            tweet(i);
        }
    })).start();
});
