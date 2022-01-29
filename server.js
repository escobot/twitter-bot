require('dotenv').config();
const fs = require('fs');
const express = require('express');
const app = express();
const sqlite3 = require('sqlite3').verbose();
const request = require('request');
const cheerio = require('cheerio');
const CronJob = require('cron').CronJob;
const Twit = require('twit');

app.use(express.static('public'));

let db = new sqlite3.Database('./local.db');

const getTwitterClients = (NUMBER_OF_CLIENTS) => {
    const twitterClients = [];
    for(let i = 0; i < NUMBER_OF_CLIENTS; i++) {
        const subreddits = JSON.parse(process.env['SUBREDDITS_' + i]);
        const twitterClient = new Twit({
            consumer_key: process.env['TWITTER_CONSUMER_KEY_' + i],
            consumer_secret: process.env['TWITTER_CONSUMER_SECRET_' + i],
            access_token: process.env['TWITTER_ACCESS_TOKEN_' + i],
            access_token_secret: process.env['TWITTER_ACCESS_TOKEN_SECRET_' + i]
        });
        twitterClients.push({ subreddits, twitterClient });
    }
    return twitterClients;
};

const IMG_DIR = process.env.IMG_DIR;

const NUMBER_OF_CLIENTS = 9;
const twitterClients = getTwitterClients(NUMBER_OF_CLIENTS);
let SUBREDDIT_RR = -1;

const fetchRedditPosts = async (twitterClientIndex, postsQueue) => {
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

                if (postUrl != "") {
                    let postDraft = {
                        'status': postTitle,
                        'hash': postHash,
                        'imageUrl': postUrl,
                        'author': postAuthor,
                        'subReddit': twitterClients[twitterClientIndex].subreddits[randomSubreddit]
                    }
                    fetchRedditImage(twitterClientIndex, postDraft, postsQueue);
                }
            });
        }
    });
};

const fetchRedditImage = async (twitterClientIndex, redditPost, postsQueue) => {
    if (redditPost.imageUrl.endsWith("jpg") || redditPost.imageUrl.endsWith(".png")) {
        request.get(encodeURI(redditPost.imageUrl), (err, res, body) => {
            if (err) {
                console.error(`Error at downloading image (if): ${redditPost.status} `, err);
            } else {
            request(encodeURI(redditPost.imageUrl))
                .pipe(fs.createWriteStream(`${IMG_DIR}${redditPost.hash}.jpg`))
                .on('close', () => {
                    redditPost.localImage = `${IMG_DIR}${redditPost.hash}.jpg`;
                    redditPost.clientId = twitterClientIndex;
                    postsQueue.push(redditPost);
                    console.log(`Successfully fetched image for reddit post: ${redditPost.status}`);
                });
            }
        });
    } else {
        request(encodeURI(redditPost.imageUrl), (err, res, body) => {
            if (err) {
                console.error(`Error at downloading image (else): ${redditPost.status} `, err);
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
                                    redditPost.clientId = twitterClientIndex;
                                    postsQueue.push(redditPost);
                                    console.log(`Successfully fetched image for reddit post: ${redditPost.status}`);
                                });
                        });
                    }
                });
            }
        });
    }
}

const tweet = async (twitterClientIndex) => {
    const redditPost = await getRedditPostForClientId(twitterClientIndex);

    if (redditPost) {
        const credits = redditPost.author != 'N/A' ? ` (${redditPost.author})` : '';
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
                                markRedditPostAsTweeted(redditPost.hash);
                            }
                        });
                    }
                });
            });
        }
    } else {
        console.error('Reddit posts not fetched yet.');
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

const getRedditPostForClientId = async (clientId) => {
    let sql = "SELECT * FROM POSTS WHERE clientId = ? AND isTweeted = 0;";
    return new Promise((resolve, reject) => {
        db.get(sql, [clientId], (err, row) => {
            if (err) reject(err);
            resolve(row);
        });
    })
};

const getRedditPostHashes = async () => {
    let sql = "SELECT hash FROM POSTS;";
    return new Promise((resolve, reject) => {
        db.all(sql, [], function(err, rows) {
            if (err) reject(err);
            resolve(rows);
        });
    })
};

const markRedditPostAsTweeted = (hash) => {
    let sql = "UPDATE POSTS SET isTweeted = 1 WHERE hash = ?;";
    return new Promise((resolve, reject) => {
        db.run(sql, [hash], function(err) {
            if (err) reject(err);
            resolve(console.log("success"));
        });
    })
};

const saveRedditPosts = async (postsQueue) => {
    const hashes = await getRedditPostHashes();
    const setHashes = new Set(hashes.map(x => x.hash));
    const redditPosts = [...new Set(postsQueue.filter(x => !setHashes.has(x.hash)))];

    db.run('CREATE TABLE IF NOT EXISTS posts ( clientId INT NOT NULL, status TEXT NOT NULL, hash CHAR(8) PRIMARY KEY NOT NULL, imageUrl TEXT NOT NULL, localImage TEXT NOT NULL, isTweeted INT NOT NULL, subReddit CHAR(20) NOT NULL, author CHAR(20) NOT NULL);')

    db.serialize(function() {
        db.run("begin transaction");
        for (var i = 0; i < redditPosts.length; i++) {
                db.run("insert into posts (clientId, status, hash, imageUrl, localImage, isTweeted, subReddit, author) values (?, ?, ?, ?, ?, ?, ?, ?)", 
                redditPosts[i].clientId, 
                redditPosts[i].status, 
                redditPosts[i].hash, 
                redditPosts[i].imageUrl, 
                redditPosts[i].localImage, 
                redditPosts[i].isTweeted, 
                redditPosts[i].subReddit, 
                redditPosts[i].author
            );
        }
        db.run("commit");
    });
    console.log("Successfully saved images to database");
};

const listener = app.listen(process.env.PORT, function() {
    console.log(`Twitter bot is running on port ${listener.address().port}`);

    // fetch reddit posts
    (new CronJob('0 * * * *', () => {
        let postsQueue = [];
        SUBREDDIT_RR++;
        for(let i = 0; i < NUMBER_OF_CLIENTS; i++) {
            fetchRedditPosts(i, postsQueue);
        }
        saveRedditPosts(postsQueue);
    })).start();

    // tweet
    (new CronJob('0 */2 * * *', () => {
        for(let i = 0; i < 2; i++) {
            tweet(i);
        }
    })).start();
});

// https://gist.github.com/wqli78/1330293/6d85cc967f32cccfcbad94ae7d088a3dcfc14bd9
const hash = (str, algorithm) => {
    if (algorithm === 'crc32') {
        return crc32(str, true);
    } else if (!algorithm) {
        algorithm = 'md5';
    }
    return crypto.createHash(algorithm).update(str).digest('hex');
};

const crc32 = (str, hex) => {    
    var crc = ~0, i;
    for (i = 0, l = str.length; i < l; i++) {
        crc = (crc >>> 8) ^ crc32tab[(crc ^ str.charCodeAt(i)) & 0xff];
    }
    crc = Math.abs(crc ^ -1);
    return hex ? crc.toString(16) : crc;
};

const crc32tab = [
    0x00000000, 0x77073096, 0xee0e612c, 0x990951ba,
    0x076dc419, 0x706af48f, 0xe963a535, 0x9e6495a3,
    0x0edb8832, 0x79dcb8a4, 0xe0d5e91e, 0x97d2d988,
    0x09b64c2b, 0x7eb17cbd, 0xe7b82d07, 0x90bf1d91,
    0x1db71064, 0x6ab020f2, 0xf3b97148, 0x84be41de,
    0x1adad47d, 0x6ddde4eb, 0xf4d4b551, 0x83d385c7,
    0x136c9856, 0x646ba8c0, 0xfd62f97a, 0x8a65c9ec,
    0x14015c4f, 0x63066cd9, 0xfa0f3d63, 0x8d080df5,
    0x3b6e20c8, 0x4c69105e, 0xd56041e4, 0xa2677172,
    0x3c03e4d1, 0x4b04d447, 0xd20d85fd, 0xa50ab56b,
    0x35b5a8fa, 0x42b2986c, 0xdbbbc9d6, 0xacbcf940,
    0x32d86ce3, 0x45df5c75, 0xdcd60dcf, 0xabd13d59,
    0x26d930ac, 0x51de003a, 0xc8d75180, 0xbfd06116,
    0x21b4f4b5, 0x56b3c423, 0xcfba9599, 0xb8bda50f,
    0x2802b89e, 0x5f058808, 0xc60cd9b2, 0xb10be924,
    0x2f6f7c87, 0x58684c11, 0xc1611dab, 0xb6662d3d,
    0x76dc4190, 0x01db7106, 0x98d220bc, 0xefd5102a,
    0x71b18589, 0x06b6b51f, 0x9fbfe4a5, 0xe8b8d433,
    0x7807c9a2, 0x0f00f934, 0x9609a88e, 0xe10e9818,
    0x7f6a0dbb, 0x086d3d2d, 0x91646c97, 0xe6635c01,
    0x6b6b51f4, 0x1c6c6162, 0x856530d8, 0xf262004e,
    0x6c0695ed, 0x1b01a57b, 0x8208f4c1, 0xf50fc457,
    0x65b0d9c6, 0x12b7e950, 0x8bbeb8ea, 0xfcb9887c,
    0x62dd1ddf, 0x15da2d49, 0x8cd37cf3, 0xfbd44c65,
    0x4db26158, 0x3ab551ce, 0xa3bc0074, 0xd4bb30e2,
    0x4adfa541, 0x3dd895d7, 0xa4d1c46d, 0xd3d6f4fb,
    0x4369e96a, 0x346ed9fc, 0xad678846, 0xda60b8d0,
    0x44042d73, 0x33031de5, 0xaa0a4c5f, 0xdd0d7cc9,
    0x5005713c, 0x270241aa, 0xbe0b1010, 0xc90c2086,
    0x5768b525, 0x206f85b3, 0xb966d409, 0xce61e49f,
    0x5edef90e, 0x29d9c998, 0xb0d09822, 0xc7d7a8b4,
    0x59b33d17, 0x2eb40d81, 0xb7bd5c3b, 0xc0ba6cad,
    0xedb88320, 0x9abfb3b6, 0x03b6e20c, 0x74b1d29a,
    0xead54739, 0x9dd277af, 0x04db2615, 0x73dc1683,
    0xe3630b12, 0x94643b84, 0x0d6d6a3e, 0x7a6a5aa8,
    0xe40ecf0b, 0x9309ff9d, 0x0a00ae27, 0x7d079eb1,
    0xf00f9344, 0x8708a3d2, 0x1e01f268, 0x6906c2fe,
    0xf762575d, 0x806567cb, 0x196c3671, 0x6e6b06e7,
    0xfed41b76, 0x89d32be0, 0x10da7a5a, 0x67dd4acc,
    0xf9b9df6f, 0x8ebeeff9, 0x17b7be43, 0x60b08ed5,
    0xd6d6a3e8, 0xa1d1937e, 0x38d8c2c4, 0x4fdff252,
    0xd1bb67f1, 0xa6bc5767, 0x3fb506dd, 0x48b2364b,
    0xd80d2bda, 0xaf0a1b4c, 0x36034af6, 0x41047a60,
    0xdf60efc3, 0xa867df55, 0x316e8eef, 0x4669be79,
    0xcb61b38c, 0xbc66831a, 0x256fd2a0, 0x5268e236,
    0xcc0c7795, 0xbb0b4703, 0x220216b9, 0x5505262f,
    0xc5ba3bbe, 0xb2bd0b28, 0x2bb45a92, 0x5cb36a04,
    0xc2d7ffa7, 0xb5d0cf31, 0x2cd99e8b, 0x5bdeae1d,
    0x9b64c2b0, 0xec63f226, 0x756aa39c, 0x026d930a,
    0x9c0906a9, 0xeb0e363f, 0x72076785, 0x05005713,
    0x95bf4a82, 0xe2b87a14, 0x7bb12bae, 0x0cb61b38,
    0x92d28e9b, 0xe5d5be0d, 0x7cdcefb7, 0x0bdbdf21,
    0x86d3d2d4, 0xf1d4e242, 0x68ddb3f8, 0x1fda836e,
    0x81be16cd, 0xf6b9265b, 0x6fb077e1, 0x18b74777,
    0x88085ae6, 0xff0f6a70, 0x66063bca, 0x11010b5c,
    0x8f659eff, 0xf862ae69, 0x616bffd3, 0x166ccf45,
    0xa00ae278, 0xd70dd2ee, 0x4e048354, 0x3903b3c2,
    0xa7672661, 0xd06016f7, 0x4969474d, 0x3e6e77db,
    0xaed16a4a, 0xd9d65adc, 0x40df0b66, 0x37d83bf0,
    0xa9bcae53, 0xdebb9ec5, 0x47b2cf7f, 0x30b5ffe9,
    0xbdbdf21c, 0xcabac28a, 0x53b39330, 0x24b4a3a6,
    0xbad03605, 0xcdd70693, 0x54de5729, 0x23d967bf,
    0xb3667a2e, 0xc4614ab8, 0x5d681b02, 0x2a6f2b94,
    0xb40bbe37, 0xc30c8ea1, 0x5a05df1b, 0x2d02ef8d
];
