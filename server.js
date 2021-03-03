'use strict';

require('dotenv').config()
const express = require('express');
const app = express();
const request = require('request');
const cheerio = require('cheerio');
const CronJob = require('cron').CronJob;
const Twit = require('twit');

const config = {
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    access_token: process.env.TWITTER_ACCESS_TOKEN,
    access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
}

let T = new Twit(config);

let subreddits = ['ColorizedHistory', 'OldPhotosInRealLife', 'HistoryPorn', 'OldSchoolCool', 'RetroFuturism', 'TrippinThroughTime', 'Lost_Architecture'];
let redditPosts = [];
let postedTweets = [];

app.use(express.static('public'));

let listener = app.listen(process.env.PORT, function () {
    console.log('MyHistoryDosis is running on port ' + listener.address().port);

    // fetch reddit posts every fifteen minutes
    (new CronJob('*/15 * * * *', function () {
        const randomSubreddit = Math.floor(Math.random() * Math.floor(subreddits.length));
        request('https://old.reddit.com/r/' + subreddits[randomSubreddit], function (err, res, body) {
            if (err) {
                console.log('Error at fetching reddit: ', err);
            } else {
                let $ = cheerio.load(body);
                $('p.title a.title').each(function () {
                    const post = $(this)[0].children[0];
                    // make sure the post is not on the "to tweet" list and has not been tweeted.
                    if (!redditPosts.some(e => e.status === post.data) && !postedTweets.some(e => e.slice(0,5) === post.data.slice(0,5))) {
                        console.log('Fetched reddit post: ' + post.data);
                        let url = post.parent.attribs['href'];
                        // if the URL is an imagur link discard it.
                        if (!url.includes("http")) {
                            redditPosts.push({ 'status': post.data, 'image_url': 'https://www.reddit.com' + url });
                        }
                        postedTweets.push(post.data.slice(0,5));
                    }
                });
            }
        });
    })).start();

    // tweet every hour
    (new CronJob('0 * * * *', function () {
        if (redditPosts.length > 0) {
            const random = Math.floor(Math.random() * redditPosts.length);
            const redditPost = redditPosts[random];
            redditPosts.splice(random, 1);
            
            let tweet = redditPost.status + ' ' + redditPost.image_url;
            
            // make sure tweet is less than 280 characters
            if (tweet.length > 280) {
                const toRemove = tweet.length - 280 + 5;
                tweet = redditPost.status.substring(0,redditPost.status.length-toRemove) + '... ' + redditPost.image_url;
            }

            T.post('statuses/update', { status: tweet }, function (err, data, response) {
                if (err) {
                    console.log('Error at statuses/update', err);
                }
                else {
                    console.log('Tweeted', `https://twitter.com/${data.user.screen_name}/status/${data.id_str}`);
                }
            });
        } else {
            console.log('Reddit posts not fetched yet.');         
        }
    })).start();
});
