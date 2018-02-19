const fetch = require('node-fetch');
const shapeshift = require('shapeshift');
const winston = require('winston');
var memoize = require('memoizee');
var promiseRetry = require('promise-retry');

var logger = new winston.Logger({
    transports: [
        new winston.transports.Console({
            level: 'info',
            handleExceptions: true,
            json: false,
            colorize: true
        })
    ],
    exitOnError: false
});

var slow_getPriceBitpay = function() {
    return new Promise((resolve, reject) => {
        try {
            let source = 'https://bitpay.com/api/rates/usd'
            fetch(source)
            .then(function(res) {
                return res.json();
            })
            .then((bpResponse) => {
                resolve({
                    "price": bpResponse.rate,
                    "source": source,
                    "time": Date.now()
                });
            })
        }
        catch(err) {
            reject(err);
        }
    })
};
getPriceBitpay = memoize(slow_getPriceBitpay, { promise: true });

function getPriceShapeShift(pair) {
    return new Promise((resolve, reject) => {
        try {
            return shapeshift.getRate(pair)
            .then(function(data){
                const body = data.body;
                getPriceBitpay()
                .then((usdbtc) => {
                    resolve({
                        "price": usdbtc.price * +body.rate,
                        "source": `shapeshift.getRate(${pair})`,
                        "time": Date.now()
                    })
                })
            })
        }
        catch(err) {
            reject(err);
        }
    })
}

var getPriceCoinMarketCap = function(currency) {
    return new Promise((resolve, reject) => {
        try {
            let source = `https://api.coinmarketcap.com/v1/ticker/${currency}/`
            fetch(source)
            .then(function(res) {
                return res.json();
            })
            .then((coinMarketCapResponse) => {
                resolve({
                    "source": source,
                    "price": coinMarketCapResponse[0].price_usd,
                    "time": Date.now()
                })
            })
        }
        catch(err) {
            reject(err);
        }
    })
};

var getPriceLiquiIo = function(pair) {
    return promiseRetry(function (retry, number) {
        logger.debug(`getPriceLiquiIo: ${pair} ${number}`);
        let source = `https://api.liqui.io/api/3/ticker/${pair}`;
        return fetch(source)
        .then(function(res) {
            return res.json();
        })
        .then((liquiResponse) => {
            if (liquiResponse[pair].buy) {
                return promiseRetry(function (retry, number) {
                    return getPriceBitpay()
                    .then((usdbtc) => {
                        return ({
                            "price": usdbtc.price * +liquiResponse[pair].buy,
                            "source": source,
                            "time": Date.now()
                        });
                    })
                    .catch(retry)
                })
            }
        })
        .catch(retry);
    }, {minTimeout: 1000})
};

var slow_fetchTickerPoloniex = function(source) {
    return fetch(source)
};
fetchTickerPoloniex = memoize(slow_fetchTickerPoloniex, { promise: true });

var getPricePoloniex = function(pair) {
    return new Promise((resolve, reject) => {
        let source = `https://poloniex.com/public?command=returnTicker`
        try {
            fetchTickerPoloniex(source)
            .then(function(res) {
                return res.json();
            })
            .then((poloniexResponse) => {
                getPriceBitpay()
                .then((usdbtc) => {
                    resolve({
                        "price": usdbtc.price * +poloniexResponse[pair].highestBid,
                        "source": source,
                        "time": Date.now()
                    })
                })
            })
        }
        catch(err) {
            reject(err);
        }
    })
};

var slow_getSummaryBitrex = function(source) {
    return new Promise((resolve, reject) => {
        try {
            fetch(source)
            .then(function(res) {
                resolve(res.json())
            })
        } catch (err) {
            reject(err);
        }


    })
};
getSummaryBitrex = memoize(slow_getSummaryBitrex, { promise: true });

var getPriceBitrex = function(pair) {
    return new Promise((resolve, reject) => {
        try {
            let source = `https://bittrex.com/api/v1.1/public/getmarketsummaries`
            getSummaryBitrex(source)
            .then((gitrexResponse) => {
                gitrexResponse.result.map((tick) => {
                    if (tick.MarketName ===  pair) {
                        logger.debug(`getPriceBitrex('${pair}'): ${tick.Bid}`)
                        getPriceBitpay()
                        .then((usdbtc) => {
                            resolve({
                                "numerator": "usd",
                                "denominator": pair,
                                "price": usdbtc.price * +tick.Bid,
                                "source": source,
                                "time": Date.now()
                            });
                        })
                    }
                })
            })
        }
        catch(err) {
            reject(err);
        }
    })
};

var slow_getSummaryAex = function(source) {
    return fetch(source)
};
getSummaryAex = memoize(slow_getSummaryAex, { promise: true });

var getPriceAex = function(pair) {
    return new Promise((resolve, reject) => {
        try {
            let source = `https://api.aex.com/ticker.php?c=all&mk_type=btc`
            getSummaryAex(source)
            .then(function(res) {
                return res.json()
            })
            .then((aexResponse) => {
                //console.log(aexResponse[pair].ticker.buy)
                getPriceBitpay()
                .then((usdbtc) => {
                    resolve({
                        "numerator": "usd",
                        "denominator": "ada",
                        "price": usdbtc.price * +aexResponse[pair].ticker.buy,
                        "source": source,
                        "time": Date.now()
                    });
                })
            })
        }
        catch(err) {
            reject(err);
        }
    })
};

function getPrice(numerator, denominator) {
    return new Promise((resolve, reject) => {
        try {
            if (numerator === denominator) {
                resolve({"price": 1});
            }
            if (denominator === 'bitcoin') {
                return getPriceBitpay()
                .then((price) => {
                    resolve(price);
                })
            }
            if (denominator === 'bitcoincash') {
                return getPriceShapeShift('bch_btc')
                .then((price) => {
                    logger.debug(`getPriceShapeShift('bch_btc'): ${price.price}`)
                    if (price.price <= 0) {
                        return getPriceLiquiIo('bcc_btc')
                        .then((price) => {
                            logger.debug(`getPriceLiquiIo('bcc_btc'): ${price.price}`)
                            if (price.price <= 0) {
                                return getPriceCoinMarketCap('bitcoin-cash')
                                .then((price) => {
                                    logger.debug(`getPriceCoinMarketCap('bitcoin-cash'): ${price.price}`)
                                    resolve(price);
                                })
                            }
                            resolve(price);
                        })
                    }
                    resolve(price);
                })
            }
            if (denominator === 'bitcoingold') {
                return getPriceCoinMarketCap('bitcoin-gold')
                .then((price) => {
                    logger.debug(`getPriceCoinMarketCap('bitcoin-gold'): ${price.price}`)
                    resolve(price);
                })
            }
            if (denominator === 'cardano') {
                return getPriceBitrex('BTC-ADA')
                .then((price) => {
                    logger.debug(`getPriceBitrex('BTC-ADA'): ${price.price}`)
                    resolve(price);
                })
            }
            if (denominator === 'zcash') {
                return getPriceShapeShift('zec_btc')
                .then((price) => {
                    logger.debug(`getPriceShapeShift('zcash'): ${price.price}`)
                    if (price.price >- 0) {
                        resolve(price);
                    } else {
                        return getPriceCoinMarketCap('zcash')
                        .then((price) => {
                            logger.debug(`getPriceCoinMarketCap('zcash'): ${price.price}`)
                            resolve(price);
                        })
                    }
                })
            }
            if (denominator === 'quantum') {
                return getPriceLiquiIo('qrl_btc')
                .then((price) => {
                    logger.debug(`getPriceLiquidIo('quantum'): ${price.price}`)
                    resolve(price);
                })
            }
            if (denominator === 'ethereum') {
                return getPriceShapeShift('eth_btc')
                .then((price) => {
                    if (price.price >= 0 ) {
                        logger.debug(`getPriceShapeShift('eth_btc'): ${price.price}`)
                        resolve(price);
                    } else {
                        return getPricePoloniex('BTC_ETH')
                        .then((price) => {
                            if (price.price >= 0 ) {
                                logger.debug(`getPricePoloniex('BTC_ETH'): ${price.price}`)
                                resolve(price);
                            } else {
                                return getPriceLiquiIo('eth_btc')
                                .then((price) => {
                                    logger.debug(`getPriceLiquiIo('eth_btc'): ${price.price}`)
                                    resolve(price);
                                })
                            }
                        })
                    }
                })
            }
            if (denominator === 'ardor') {
                return getPriceBitrex('BTC-ARDR')
                .then((price) => {
                    logger.debug(`getPriceBitrex('BTC-ARDR'): ${price.price}`)
                    if (price.price >= 0 ) {
                        resolve(price);
                    } else {
                        return getPriceAex('ardr')
                        .then((price) => {
                            logger.debug(`getPriceAex('ardr'): ${price.price}`)
                            if (price.price >= 0 ) {
                                resolve(price);
                            } else {
                                return getPricePoloniex('BTC_ARDR')
                                .then((price) => {
                                    logger.debug(`getPricePoloniex('BTC_ARDR'): ${price.price}`)
                                    if (price.price >= 0 ) {
                                    resolve(price);
                                    } else {
                                        return getPriceCoinMarketCap('ardor')
                                        .then((price) => {
                                            logger.debug(`getPriceCoinMarketCap('ardor'): ${price.price}`)
                                            resolve(price);
                                        })
                                    }
                                })
                            }
                        })
                    }
                })
            }
            resolve({"price": 0});
        }
        catch(err) {
            reject(err);
        }
    })
}

function portfolio() {
    let priceRequests = [];
    let grandTotalUSD = 0;
    let assets = require('./assets.json');
    let expenses = require('./expenses.json');

    Object.keys(assets).map((asset) => {
        priceRequests.push(
            promiseRetry(function (retry, number) {
                //logger.debug(`${asset}: ${number}`)
                return getPrice('usdollar', asset, 1)
                .catch(retry);
            })
        )
    })

    Promise.all(priceRequests)
    .then((priceResults) => {
        let i = 0;
        Object.keys(assets).map((asset) => {
            assets[asset].price = priceResults[i].price;
            assets[asset].source = priceResults[i].source || "";
            assets[asset].time = priceResults[i].time || -1;
            assets[asset].amount = (
                +0.0 +
                (+assets[asset].amount || +0.0 ) +
                (+assets[asset].blockchain || +0.0 ) +
                (+assets[asset].legacy || +0.0 ) +
                (+assets[asset].segwit || +0.0 ) +
                (+assets[asset].bitpay || +0.0 ) +
                (+assets[asset].cash || +0.0 ) +
                (+assets[asset].onpoint || +0.0 )
            );
            assets[asset].usdtotalval = (priceResults[i].price * assets[asset].amount);
            i++
        })
    })
    .then(() => {
        Object.keys(assets).map((asset) => {
            grandTotalUSD += +assets[asset].usdtotalval;
            months = +grandTotalUSD / expenses.monthly;
            return
        })
    })
    .then(() => {
        Object.keys(assets).map((asset) => {
            console.log(`"${asset}": {"price": ${parseFloat(+assets[asset].price).toFixed((assets[asset].decimals) || 0) },"amount": ${parseFloat(assets[asset].amount).toFixed(2)},"usd": ${parseFloat(+assets[asset].usdtotalval).toFixed(2)},"weight": "${parseInt(((parseFloat(+assets[asset].usdtotalval) / +grandTotalUSD) * 100) + .5)}%", "source": "${assets[asset].source}", "time": "${assets[asset].time}"},`);
            return
        })
        console.log('')
    })
    .then(() => {
        console.log(`"total (usd)": ${grandTotalUSD.toFixed(2)},`)
        getPriceBitpay()
        .then((usdbtc) => {
            console.log(`"total (btc)": ${(grandTotalUSD / usdbtc.price).toFixed(2)},`);
            console.log('');
        })
    })
    .then(() => {
        console.log(`"starvation": "${Math.floor(months / 12)} year${(Math.floor(months / 12) === 1) ? '' : 's'} ${Math.floor(months % 12)} month${(Math.floor(months % 12) === 1) ? '' : 's'} ${Math.floor(30 * (months - Math.floor(months)))} day${(Math.floor(30 * (months - Math.floor(months))) === 1) ? '' : 's'}"`)
        console.log('');
    })
    .catch((err) => logger.debug(err));
}

portfolio();
