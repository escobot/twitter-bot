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

let redditPosts = [];

app.use(express.static('public'));

let listener = app.listen(process.env.PORT, function () {
    console.log('MyHistoryDosis is running on port ' + listener.address().port);

    // fetch reddit posts everyday at midnight
    (new CronJob('* * * * *'', function () {
        request('https://old.reddit.com/r/HistoryPorn/', function (err, res, body) {
            if (err) {
                console.log('Error at fetching reddit: ', err);
            } else {
                let $ = cheerio.load(body);
                $('p.title a.title').each(function () {
                    const post = $(this)[0].children[0];
                    redditPosts.push({ 'status': post.data, 'image_url': post.parent.attribs['href'] })
                });
            }
        });
    })).start();

    // tweet every 12hrs
    (new CronJob('* * * * *'', function () {
        const redditPost = redditPosts.pop();
        const tweet = redditPost.status + ' #history ' + redditPost.image_url; 
        T.post('statuses/update', { status: tweet }, function (err, data, response) {
            if (err) {
                console.log('Error at statuses/update', err);
            }
            else {
                console.log('tweeted', `https://twitter.com/${data.user.screen_name}/status/${data.id_str}`);
            }
        });
    })).start();
});
