/*
 * Utility functions for handyjs
 */

'use strict';

const crypto = require('crypto')
  , util = require('util')
  , _ = require('underscore')
  ;

/*
 * Create crytographically random string
 * 
 * @param {int} len - length of string created
 * @api public
 */
exports.generateRandomString = generateRandomString;

function generateRandomString(len = 15){
  let randomString;

  try {
    randomString = crypto.randomBytes(len)
                      .toString('base64');

    randomString = encodeURIComponent(randomString)
                      .replace(/%/g, 'p')
                      .slice(0,len);

    return randomString;
  } 
  catch(err) {
    // backup algo in case crypto.randomBytes throws an error
    len = len > 8 ? 8 : len;  // set maximum value of 8
    randomString = Math.random().toString(36).slice(-len)
    return randomString;
  }
}


/*
 * WARNING: DO NOT USE.  DOES NOT WORK. ONLY KEPT UNTIL ALL DEPENDENT CODE IS REFACTORED 
 * WARNING: This function returns after the first promise is executed.  
 *          All other promises are executed but the program continues to 
 *          execute the next line after this function call
 * Execute array of promises in specific order
 * This is an alternative to Promise.all where the order of execution is unpredictable
 * Also, enables introduction of a delay between execution of each promise
 * (useful for example in situations where promise execution encounters rate limiting)
 * 
 * @param {array} promiseArray - array of promises to be executed
 * @param {int} delay - delay (in milliseconds) between execution of each promise
 * @api public
 */
exports.executePromisesInSeriesWithDelay = executePromisesInSeriesWithDelay;

function executePromisesInSeriesWithDelay(promiseArray, delay=0, context=null){ 
  const initPromise = Promise.resolve();  // dummy promise to kick off the reduce function
  if(!promiseArray || !promiseArray.length){
    return Promise.resolve();
  }

  return promiseArray.reduce((p1, p2)=>{
    return p1.then(delayPromise.bind(null, delay)).then(p2)
  }, initPromise)

}

function delayPromise(delay, passThrough){
  return new Promise((resolve, reject)=>{
    setTimeout(()=>{
      return resolve(passThrough);
    }, delay);
  })
}


/*
 * trim space around all text entries in a form
 *
 * @param {object} form - form entries
 * @api public
 */
exports.trimFormTextEntries = trimFormTextEntries;

function trimFormTextEntries(form){
  _.forEach(form, function(entry, field){
    form[field] = typeof entry === 'string' ? entry.trim() : form[field];
  });

  return form;
}


/*
 * Remove last occurence of a character
 * Particularly useful to remove trailing comma from strings generated
 * in loops e.g. "string1, string2, string3,"
 *
 * @param {string} string - string to be modified
 * @param {string} character - character or string to be removed
 * @api public
 */
exports.removeTrailingCharacter = removeTrailingCharacter;

function removeTrailingCharacter(string=null, character=null){
  if(!string || !character){return string; }
  if(string.substr(string.length - character.length, character.length) === character){
    string = string.substr(0, string.length - character.length);
  }
  return string;
}


/*
 * convert string to sentence case i.e. capitalize first letter e.g. "Mike", "Echo"
 *
 * @params {string} string - string to be modified
 * @api public
 */
exports.toSentenceCase = toSentenceCase;

function toSentenceCase(string){
  if(!string || typeof string !== 'string'){return string}
  string = string.substr(0, 1).toUpperCase() + string.substr(1).toLowerCase();
  return string
}


/* send output to console
 * expand all child objects
 * 
 * @api public
 */
exports.consoleLog = consoleLog;

function consoleLog(){
  let output;
  const args = Array.from(arguments);
  args.forEach((arg)=>{
    if(typeof arg === 'object'){
      output = util.inspect(arg, {depth: null, colors: true, maxArrayLength: null});
      console.log(output);
    } else {
      console.log(arg)
    }
  })
}



/*
 * clone objects to avoid passing by reference
 *
 * @param {object} target - object to be cloned
 * @api public
 */
exports.clone = clone;

function clone(target) {
  return JSON.parse(JSON.stringify(target));
}


/*
 * round decimals to the required number of places
 *
 * @param {float} target - number to be rounded
 * @param {int} decimalPlaces - number of decimal places to return
 * @api public
*/
exports.roundToDecimalPlaces = roundToDecimalPlaces;

function roundToDecimalPlaces(target, decimalPlaces) {
  const multiplier = 10 ** decimalPlaces;
  target = target * multiplier;
  target = Math.round(target);
  target = target / multiplier;
  return target;
}


/*
 * ratelimit calls to a function
 * ensures a function will not be triggered more frequently than specified
 * and will not drop calls between triggers
 *
 * @param {function} func - function to apply rate limit on
 * @param {int} rate - time in between succesive triggers of the function
 * @param {bool} async - if true, function does not wait on completion of previous execution to queue next request
 * @api public
*/
exports.rateLimit = rateLimit;

function rateLimit(func, rate, async=false) {
  var queue = [];
  var timeOutRef = false;
  var currentlyEmptyingQueue = false;
  
  var emptyQueue = function() {
    if (queue.length) {
      currentlyEmptyingQueue = true;
      _.delay(function() {
        if (async) {
          _.defer(function() { queue.shift().call(); });
        } else {
          queue.shift().call();
        }
        emptyQueue();
      }, rate);
    } else {
      currentlyEmptyingQueue = false;
    }
  };
  
  return function() {
    var args = _.map(arguments, function(e) { return e; }); // get arguments into an array
    queue.push( _.bind.apply(this, [func, this].concat(args)) ); // call apply so that we can pass in arguments as parameters as opposed to an array
    if (!currentlyEmptyingQueue) { emptyQueue(); }
  };
}