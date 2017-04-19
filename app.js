const fetch = require('node-fetch');
const shapeshift = require('shapeshift');
var memoize = require('memoizee');

var slow_getPriceBitpay = function() {
    return new Promise((resolve, reject) => {
        try {
            fetch('https://bitpay.com/api/rates/usd')
            .then(function(res) {
                return res.json();
            })
            .then((bpResponse) => {
                resolve(bpResponse.rate);
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
            shapeshift.getRate(pair)
            .then(function(data){
                const body = data.body;
                getPriceBitpay()
                .then((usdbtc) => {
                    resolve(usdbtc / +body.rate);
                })
            });
        }
        catch(err) {
            reject(err);
        }
    })
}

function getPrice(numerator, denominator) {
    return new Promise((resolve, reject) => {
        try {
            if (denominator === 'bitcoin') {
                return getPriceBitpay()
                .then((price) => {
                    resolve(price);
                })
            }
            if (denominator === 'zcash') {
                return getPriceShapeShift('btc_zec')
                .then((price) => {
                    resolve(price);
                })
            }
            if (numerator === denominator) {
                resolve(1);
            }
            resolve(0);
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

    Object.keys(assets).map((asset) => {
        priceRequests.push(getPrice('usdollar', asset))
    })

    Promise.all(priceRequests)
    .then((priceResults) => {
        let i = 0;
        Object.keys(assets).map((asset) => {
            assets[asset].price = priceResults[i];
            assets[asset].usdtotalval = (priceResults[i] * +assets[asset].amount);
            i++
        })
    })
    .then(() => {
        Object.keys(assets).map((asset) => {
            console.log(`${asset}: {price: ${parseFloat(+assets[asset].price).toFixed(2)}, amount: ${parseFloat(assets[asset].amount).toFixed(2)}, usd: ${parseFloat(+assets[asset].usdtotalval).toFixed(2)}}`);
            grandTotalUSD += +assets[asset].usdtotalval
            return
        })
    })
    .then(() => {
        console.log('');
        console.log(`grandTotal (in USD): ${grandTotalUSD.toFixed(2)}`)
        console.log('');
    })
}

portfolio();
