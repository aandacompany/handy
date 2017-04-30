/*
 * General system functionality for handy.js
 */
'use strict';

var _ = require('underscore')
	, async = require('async')
	, mysql = require('mysql')
  , email = require('../node_modules/emailjs/email')
	, utility = require('./utility')
  , exec = require('child_process').exec
  , fs = require('fs')
  , path = require('path')
  , mandrill = require('mandrill-api/mandrill')
  , bunyan = require('bunyan')
  , crypto = require('crypto')
	;


/*
 * find the location of the handy directory
 *
 * @api public
 */
exports.findHandyDirectory = findHandyDirectory;

function findHandyDirectory(){
  // get current directory for this module and put into object form
  let pathObject = path.parse(__dirname);
  
  // remove unwanted portions i.e file names and type
  delete pathObject.base;
  delete pathObject.ext;
  delete pathObject.name;

  // reconstitute the path (now having only the parent directory i.e. handy)
  let handyDirectory = path.format(pathObject);

  return handyDirectory;
}

var handyDirectory = findHandyDirectory();

/*
 *  secret strings are the random strings used in stuff like session secrets, cookie secrets and the redis
 *  site prefix.
 * secret strings are stored in a flat file in the config directory.  we do not use the systemVariable to
 * store them because the strings are often required before the systemVariable is initialized
 */

var secretStrings = {};  // will contain the session secret, cookie secret and redis prefix for this site
(function (){
  try {
    let fd = fs.openSync(path.join(handyDirectory, 'config', 'randomized-strings.js'), 'r'); 
    secretStrings = require(path.join(handyDirectory, 'config', 'randomized-strings')); 
  }
  catch(err){
    // randomized_strings.js does not exist.  initialize it
    secretStrings = {
      sessionSecret: _generateRandomString(20),
      cookieSecret: _generateRandomString(20),
      redisPrefix: _generateRandomString(5) + '_',
    };

    // create text for file
    let text = "/*\n * Randomized strings for use in the site\n */";
    text += "\n\n'use strict';";
    text += "\n\n";
    text += "let randomizedStrings = {\n";
    text += "\tsessionSecret: '" + secretStrings.sessionSecret + "',\n";
    text += "\tcookieSecret: '" + secretStrings.cookieSecret + "',\n";
    text += "\tredisPrefix: '" + secretStrings.redisPrefix + "',\n";
    text += "};\n\n";
    text += "module.exports = randomizedStrings;"

    // write file
    fs.writeFileSync(path.join(handyDirectory, 'config', 'randomized-strings.js'), text, {mode: 384});
  }
})();

exports.secretStrings = secretStrings;


function _generateRandomString(len){
  len = len || 15;  // set default value of len
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
 * Define global objects
 *
 */

// systemVariable: global variable used to pass data across handy
var systemVariable = {
  config: {},

  _initialFunction: function(){
    // initial function is the starting function to be executed by the project
    return new Promise(function(resolve, reject){
      resolve();
    });
  },

  // setter for updating the initial function
  set initialFunction(func){
    if(typeof func !== 'function'){ 
      console.log('WARNING: initialFunction is required to be a function.  Please modify your code accordingly.\n\nExecution terminating...');
      return;
    }
    this._initialFunction = func;
  },

  // getter for initial function
  get initialFunction(){
    return this._initialFunction;
  },
  
  get: function(key){
    if(systemVariable[key] === undefined){systemVariable.set(key, null);}
    return systemVariable[key];
  },

  set: function(key, value){
    if(key === 'set' || key === 'get' || key === 'updateConfig' || key === 'getConfig'){return new Error('Error updating systemVariable: can\'t overwrite internal function');}
    systemVariable[key] = value;
    return;
  },
  
  updateConfig: function(update, callback){
    var pool = systemVariable.get('pool');
    /* update is an object with the attributes to update in config */
    _.forEach(update, function(val, key){
      systemVariable.config[key] = val;
    });
    
    // save systemVariable to database
    pool.getConnection(function(err, connection){
      if(err){return callback(err);}
      
      var currentConfig = JSON.stringify(systemVariable.get('config'));
      var query = 'INSERT INTO siteconfig(id, config) VALUES(1, ';
      query += connection.escape(currentConfig);
      query += ') ON DUPLICATE KEY UPDATE config = ';
      query += connection.escape(currentConfig);
    
      connection.query(query, function(err, results){
        connection.release();
        if(err){return callback(err);}
        return callback(null);
      });
    });   
  },
  
  getConfig: function(key){
    var config = systemVariable.get('config');
    if(config === null){
      systemVariable.set('config', {});
      return null;
    }
    if(config[key] === undefined){
      return null;
    }
    
    return config[key];
  }
};

exports.systemVariable = systemVariable;


/* 
 * BaseObject: basic object class on which other objects are constructed
 *
 * @param {object} objectInitializer - object with structure
 *  objectInitializer = {
      key1: value1,
      key2: value2
    }
 * @param {object} schema - database schema description for the object.  Key matches the table columns while Value is the database entry.
 * @api public
 */
exports.BaseObject = BaseObject;

function BaseObject(objectInitializer, schema){
   
   utility.populateNewObject.call(this, objectInitializer);
   
   this.schema = {
    tableName: schema.tableName
   };
   
   // set description for base columns
   this.schema.columns = {
    id: {type: 'INT', size: 10, null: false, primary: true, auto_increment: true, primarykey: true},
    createdate: {type: 'DATETIME', null: false, default: 'CURRENT_TIMESTAMP'},
    modifydate: {type: 'DATETIME', null: false, default: 'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'},
    deleted: {type: 'BOOL', null: false, default: false},
    organization: {type: 'INT', size: 10, null: true, foreignkey:{name:'fk_organization', reference:{table: 'organization', column: 'id'}, onupdate: 'CASCADE', ondelete: 'CASCADE'}}
   };
   
   // add the new columns
   _.forEach(schema.columns, function(val, key){
    this.schema.columns[key] = val;
   }, this);
}


// gets the value of an attribute of the object.  returns null if attribute does not exist
BaseObject.prototype.get = function(attribute){
  var value = null;
  if(this.hasOwnProperty(attribute)){
    value = this[attribute];
  }
  return value;
}


/* 
 * Set the value of an attribute of the object. returns an error or the changed object
 * @param {string} attribute - the object property to be set
 * @param {all datatypes} value - the value to which the property is to be set
 * @api public
 */
BaseObject.prototype.set = function(attribute, value, callback){
  // perform rudimentary validation on attributes.  only perform validation of attributes with defined schema
  if(this.schema.columns[attribute]){
    var type = typeof this.schema.columns[attribute].type !== 'undefined' ? this.schema.columns[attribute].type : null;
    var nullattr = typeof this.schema.columns[attribute].null !== 'undefined' ? this.schema.columns[attribute].null : null;
    
    // perform rudimentary validation
    switch(type){
      case 'INT':
      case 'FLOAT':
        if(typeof value !== 'number'){
          return callback(new Error('Error setting object attribute: wrong data type: number required'));
        }
        break;
      case 'DATETIME':
        if(!(value instanceof Date)){
          return callback(new Error('Error setting object attribute: wrong data type: date required'));
        }
        break;
      case 'VARCHAR':
      case 'TEXT':
      case 'LONGTEXT':
      case 'ENUM':
        if(typeof value !== 'string'){
          return callback(new Error('Error setting object attribute: wrong data type: text required'));
        }
        break;
      case 'BOOL':
        if(typeof value !== 'boolean'){
          return callback(new Error('Error setting object attribute: wrong data type: boolean required'));
        }
        break;
    }
    
    switch(nullattr){
      case true:
        break;
      case false:
        if (value === null){
          return callback(new Error('Error setting object attribute: cannot set this attribute to null'));
        }
        break;
    }
  
  }
  
  // set value
  this[attribute] = value;
  return callback(null, this);
}


// delete object
BaseObject.prototype.delete = function(callback){
  this.set('deleted', true, function(err, deleted_object){
    return callback(err, deleted_object);
  });
}


// undelete object
BaseObject.prototype.undelete = function(callback){
  this.set('deleted', false, function(err, undeleted_object){
    return callback(err, undeleted_object);
  });
}


/* 
 * Create database tables to store object records
 *
 * @api public
 */
BaseObject.prototype.createTable = function(callback){

  /*
   * NOTES:
   * DEFAULT values for text need to be wrapped in '' e.g. default: \' + defaulttextvalue + \'
   */
  const pool = systemVariable.get('pool');
  let query;

  pool.getConnection((function(err, connection){
    if(err){return callback(err);}
   
    // disable foreign key checks
    query = 'SET foreign_key_checks = 0';
    connection.query(query, (function(err){
      if(err){ return callback(err); }

      query = 'CREATE TABLE IF NOT EXISTS ' + this.schema.tableName + ' (';
      let primarykeyArray = []
        , foreignkeyArray = []
        , indexkeyArray = []
        ;
      _.forEach(this.schema.columns, function(description, column_name){
        
        query += column_name + ' ' + description.type;

        // if column type is BLOB, MEDIUMBLOB, LONGBLOB, etc then skip SIZE, NULL, AUTO_INCREMENT and DEFAULT
        let specialTextDataTypes = [
          "TINYBLOB", 'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT'
        ];

        if(!_.intersection(specialTextDataTypes, [description.type]).length){

          // add SIZE
          if(typeof description.size !== 'undefined'){
            query += '(' + description.size + ')';
          }
          
          query += ' ';
          
          // add NULL
          let nullattr = (typeof description.null === 'undefined' || description.null === true) ? 'NULL' : 'NOT NULL';
          query += nullattr + ' ';
          
          // add AUTO_INCREMENT
          let auto_incrementattr = (typeof description.auto_increment !== 'undefined' && description.auto_increment === true) ? 'AUTO_INCREMENT ' : '';
          query += auto_incrementattr;
          
          // add DEFAULT
          let defaultattr = (typeof description.default !== 'undefined') ? 'DEFAULT ' + description.default + ' ': '';
          query += defaultattr;

        }
        
        query += ', ';
        
        // check if this is a PRIMARY KEY
        let primarykeyattr = (typeof description.primarykey !== 'undefined' && description.primarykey === true) ? true : false;
        if(primarykeyattr){
          primarykeyArray.push(column_name);
        }
        
        // check if this is a FOREIGN KEY
        let foreignkeyattr = (typeof description.foreignkey !== 'undefined') ? true : false;
        let for_key;
        if(foreignkeyattr){
          for_key = {
            column_name: column_name,
            description: description
          };
          foreignkeyArray.push(for_key);
        }

        // check if this is an INDEX column
        let indexkeyattr = (description.index) ? true : false;
        if(indexkeyattr){
          indexkeyArray.push(column_name);
        }
      });
      
      // add PRIMARY key
      if(primarykeyArray.length){
        query += 'PRIMARY KEY(' + primarykeyArray.toString() + '), ';
      }
      
      // add INDEX key
      if(indexkeyArray.length){
        indexkeyArray.forEach(function(indexColumn){
          query += 'INDEX(' + indexColumn + '), ';
        });
      }
      
      // add FOREIGN key
      if(foreignkeyArray.length){
        foreignkeyArray.forEach(function(for_key){
          query += 'FOREIGN KEY ' + for_key.description.foreignkey.name + '(' + for_key.column_name + ') ';
          query += 'REFERENCES ' + for_key.description.foreignkey.reference.table + '(' +  for_key.description.foreignkey.reference.column + ') ';
          query += 'ON UPDATE ' + for_key.description.foreignkey.onupdate + ' ';
          query += 'ON DELETE ' + for_key.description.foreignkey.ondelete + ', ';
        });
      }
      
      // remove trailing comma
      query = utility.removeLastCharacter(',', query);
      
      query += ')';

      // run the query
      connection.query(query, function(err, results){
        if(err){return callback(err);}

        // restore foreign key checks
        query = 'SET foreign_key_checks = 1';
        connection.query(query, function(err){
          if(err){return callback(err);}
          connection.release();
          return callback(err, results);
        });
      });
    }).bind(this));
  }).bind(this));
}


/*
 * Load object into memory from database
 *
 * @param {integer/string} id - unique identifier of the object being loaded
 * @param {string} type - type of identifier
 * @api public
 */ 
BaseObject.prototype.load = function(id, type, callback){
  if(arguments.length === 2){
    callback = type;
    type = 'id';
  }
  genericLoad.bind(this, id, type, callback)();
}

/*
 * Generic load functionality
 * This function is created because it is reused in multiple situations and so should be called out
 *
 * @param {integer/string} id - unique identifier of object being loaded
 * @param {string} type - type of identifier
 * @api public
 */
exports.genericLoad = genericLoad;

function genericLoad(id, type, callback){
  const pool = systemVariable.get('pool');
  pool.getConnection((function(err, connection){
    if(err){return callback(err);}
        
    let query = "SELECT * FROM " + this.schema.tableName + " WHERE " + mysql.escapeId(type) + " = " + connection.escape(id);
    connection.query(query, (function(err, results){
      connection.release();

      if(err){return callback(err);}
      
      if(results.length < 1){return callback(new Error('not found'));}
      
      // populate object with data from database
      this.cloneObject(results[0])

      return callback(null, this);
      
    }).bind(this));
  }).bind(this));
}


/* 
 * Save object to database
 * 
 * @api public
 */
BaseObject.prototype.save = function(callback){
  genericSave.bind(this, callback)();
}

/*
 * Generic save functionality
 * This function is created because it is reused in multiple situations and so should be called out
 *
 * @api private
 */
exports.genericSave = genericSave;

function genericSave(callback){
  /*
   * NOTE: Only properties with defined schema are saved to the database
   */
    var that = {};  // used as temporary cache for any values that get changed during the save process
    var pool = systemVariable.get('pool');
    pool.getConnection((function(err, connection){
      if(err){err.message = 'database pool connection error'; return callback(err);}
      // get list of properties to be saved (as compared to the schema)
        var savePropertyList = [];
        _.forEach(this, function(val, key){
          _.forEach(this.schema.columns, function(record, column_name){
            if(key === column_name){
              // modifydate and createdate are automatically updated by the database so remove them
              if(key !== 'modifydate' && key !== 'createdate'){
                savePropertyList.push(key);
              }
            }
          }, this);
        }, this);
      
        // if there are no fields changed, then end processing
        if(!savePropertyList.length){
          var error = new Error();
          error.message = 'no fields available to save.  save aborted';
          return callback(error);
        }
      
        // construct query to save object
        var query;
        query = 'INSERT INTO ' + this.schema.tableName + ' (' + savePropertyList.toString() + ') VALUES (';
        savePropertyList.forEach((function(val, key){
        
          // convert Datetime strings to Date objects, if necessary
          if(this.schema.columns[val].type === 'DATETIME' && typeof this[val] === 'string'){
            this[val] = new Date(this[val]);
          }
        
          // convert arrays and objects into JSON
          if(this.schema.columns[val].type === 'VARCHAR' && (Array.isArray(this[val]) || _.isObject(this[val]))){
            that[val] = this[val]; // save the value of this key so it can be reverted after the save is done
            this[val] = JSON.stringify(this[val]);
          }

          query += connection.escape(this[val]) + ', ';
        }).bind(this));
        query = utility.removeLastCharacter(',', query);
        query += ') ON DUPLICATE KEY UPDATE ';
        savePropertyList.forEach((function(val, key){
      
          // convert Datetime strings to Date objects, if necessary
          if(this.schema.columns[val].type === 'DATETIME' && typeof this[val] === 'string'){
            this[val] = new Date(this[val]);
          }
        
          // convert arrays and objects into JSON
          if(this.schema.columns[val].type === 'VARCHAR' && (Array.isArray(this[val]) || _.isObject(this[val]))){
            that[val] = this[val]; // save the value of this key so it can be reverted after the save is done
            this[val] = JSON.stringify(this[val]);
          }
        
          query += val + ' = ' + connection.escape(this[val]) + ', ';
        }).bind(this));
        query = utility.removeLastCharacter(',', query);

        connection.query(query, (function(err, result){
          connection.release();
          if(err){
            err.message = 'record could not be saved'; return callback(err);}
          /* if the object does not already have an id, then get the id returned from MySQL
           * Otherwise, keep the original id.  This is necessary because of the following scenarios:
           * (1) New record being saved: BaseObject.id is undefined so should be updated from query results
           * (2) Old record is being updated: BaseObject.id is already specified, so no need to change it
           * (3) Old record is being updated but with exactly the same information: Here's where it gets tricky.
           *     When you update an existing record with exactly the same information, MySQL returns an insertId
           *     of zero.  Hence, you cannot trust that the insertId value is always accurate.
           */
          this.id = typeof this.id !== 'undefined' ? this.id : result.insertId;
        
          // revert any changes made to key types e.g. all arrays have been converted to JSON strings so need
          // to convert back to arrays
          _.forEach(that, (function(val, key){
            this[key] = val;
          }).bind(this));
        
          return callback(null, this);
        }).bind(this));
    }).bind(this));
}


/*
 * update all the properties with those from the source
 * also performs some transformations e.g. transforms datetime strings into date objects
 * NOTE: This function bypasses the validation checks built into BaseObject.set so it is possible
 * to have an object with the wrong value types (as compared to the schema definition)
 *
 * @param {object} sourceObject - source object which provides all the properties
 * @api public
 */
BaseObject.prototype.cloneObject = function(sourceObject){
  _.forEach(sourceObject, function(val, key){
    if(this.schema.columns[key] && this.schema.columns[key].type === 'DATETIME' && typeof val === 'string'){
      // convert datetime strings to actual date objects
      this[key] = new Date(val);
    } else {
      // too dangerous to allow overwriting schema (otherwise object types could mutate with unpredictable results) so prevent this possibility
      if(key !== 'schema'){
       this[key] = val; 
      }
    }
  }, this);
  return this;
}


/*
 * Get the associated organization status
 *
 * 'this' for the function is bound to the target object
 */
exports.getOrganizationStatus = getOrganizationStatus;

function getOrganizationStatus(){
  return new Promise((function(resolve, reject){
    // if there is no organization specified, stop processing
    this.organization = this.organization || null;
    if(this.organization === null){
      this.status.organization = [];
      return resolve(this.status.organization)
    }

    const pool = systemVariable.get('pool');
    pool.getConnection((function(err, connection){
      if(err){ return reject(err); }
      let query = 'SELECT status FROM organization ';
      query += 'WHERE id = ' + connection.escape(this.organization)
      connection.query(query, (function(err, result){
        connection.release();
        if(err){ return reject(err); }
        if(!result.length){ return reject(new Error('could not find organization with id: ' + this.organization)); }
        this.status.organization = JSON.parse(result[0].status);
        return resolve(this);
      }).bind(this));
    }).bind(this));
  }).bind(this));
}


/*
 * Set and retrieve system messages
 *
 * @param {string} msgType - types of system messages e.g. 'success', 'warning' and 'dev'
 * @param {string} msg - message for display
 * @param {bool} clearFlag - flag to delete messages after reading. Set to 'true' to delete messages (default)
 * @param {obj} res - Express response object
 */
var systemMessage = {
  set: function(req, msgType, msg){
    if(!req.session.msgCache){req.session.msgCache = {}; } //initialize sysmessage
    if(req.session.msgCache[msgType]){
      // prevent duplication of messages.  if message is already present, do not set again
      if(_.intersection(req.session.msgCache[msgType], [msg]).length > 0){
        return req.session.msgCache[msgType];
      } else {
        req.session.msgCache[msgType] = req.session.msgCache[msgType].concat([msg]); // add new message to existing messages
      }
    } else {
      req.session.msgCache[msgType] = [msg]; // create message array for msgType
    }

    return req.session.msgCache[msgType];
  },

  get: function(req, msgType, clearFlag){
    msgType = msgType || null; // default value of msgType is null
    clearFlag = typeof clearFlag === 'undefined' ? true : clearFlag; // default value of clearFlag is true
    
    if(!req.session.msgCache){return false; } // stop processing if there are no messages at all

    var msg;
    switch (msgType){
      case null:
        msg = req.session.msgCache;
        if(clearFlag){delete req.session.msgCache; }
        return msg;
        break;
      default:
        msg = {};
        msg[msgType] = req.session.msgCache[msgType];
        if(clearFlag){delete req.session.msgCache[msgType]; }
        return msg;
    }
  },
}


exports.systemMessage = systemMessage;

/*
 * Restore system messages before a redirect
 * NOTE: Invoke this function before res.redirect if another function (such as prepGetRequest) has 
 *       moved system messages from req.session.msgCache to res.locals.sysmessage
 * Invoking res.redirect wipes out the previous res object.  This is a problem if
 * the system messages have been transferred from req.session.msgCache to res.locals.sysmessage
 * (as occurs after prepGetRequest has been called).  restoreSystemMessage moves the system messages
 * safely back to req.session.msgCache.
 *
 * @param {object} req - expresss request object
 * @param {object} res - express response object
 * @api public
 */ 
exports.restoreSystemMessage = restoreSystemMessage;

function restoreSystemMessage(req, res){
  var msg = res.locals.sysmessage;
  _.forEach(msg, function(text, type){
    systemMessage.set(req, type, text.toString());
  });
  return;
}


/*
 * send email to receipient
 *
 * @param {object} receipient - email receipient (format: {name: <receipient name>, email: <receipient email>})
 * @param {object} sender - email sender's address (format: {name: <sender name>, email: <sender email>})
 * @param {string} subject - email subject
 * @param {object} body - email body as text and html. (format {text: <body as text>, html: <body as html>})
 * @param {string} cc (optional) - email cc's address (format address or name <address> or "name <address>")
 * @param {array} attachment (optional) - array of attachments to email.  format of each attachment {path: <path>, name: <name of file>, data: <base64 data stream>, type: <file type>}
 * @param {string} replyAddress (optional) - reply to address for the email
 * @api public
 */
exports.sendEmail = sendEmail;

function sendEmail(receipient, sender, subject, body, cc, attachment, replyAddress, callback){
  // if cc, attachment or reply-address arguments are omitted, ensure callback is properly handled
  if(arguments.length === 5){callback = cc; cc = undefined;}
  if(arguments.length === 6){callback = attachment; attachment = undefined;}
  
  replyAddress = replyAddress || sender;
  if(cc === null){cc = undefined;}
  if(attachment === null){attachment = undefined;}
  
  // send email only if the app is in production mode
  if(process.env.NODE_ENV !== 'production'){
    return callback(null, null);
  }
  
  // select mail agent
  var message;
  var text = body.text;
  var html = body.html || text.replace(/\r?\n/g, '<br/>').replace(/ /g, '&nbsp;');
  switch(systemVariable.getConfig('emailAgent')){
    case 'mandrill':
      // abort processing if no mandrill api is given
      if (!systemVariable.getConfig('mandrillApiKey')){
        return callback(new Error('email could not be sent.  service api key missing'));
      }

      message = {
        'html': html,
        'text': text,
        'subject': subject,
        'from_email': sender.email,
        'from_name': sender.name,
        'to': [{
          "type": 'to',
          "email": receipient.email,
          "name": receipient.name
          }],
          "headers": {
            "Reply-To": replyAddress
          }
      };

      if(attachment){
        // if attachments, process attachments

        var attachmentArray = [];  // will contain the attachment objects
         // set up async function
        var asyncFn = [];
        attachment.forEach(function(attach){
          asyncFn.push(
              function(asyncCallback){
                // get attachment data as base64 string
                var attachStream = fs.createReadStream(attach.path, {encoding: 'base64'});
                var attachBase64 = '';
                attachStream
                  .on('data', function(chunk){
                    attachBase64 += chunk;
                  })
                  .on('end', function(){
                    attachmentArray.push({type: attach.type, name: attach.name, content: attachBase64});
                    asyncCallback();
                  });

                attachStream.on('error', function(err){
                  asyncCallback(err);
                });
              }
            );

          async.parallel(asyncFn, function(err){
            if(err){return callback(err);}
            message.attachments = attachmentArray;  // update message with attachments
            // send messages using Mandrill
            _mandrillClientMessageSend(message, function(err, msg){
              return callback(err, msg);
            });
          });
        });       
      } else {
        // no attachments so just send the message
        _mandrillClientMessageSend(message, function(err, msg){
          return callback(err, msg);
        });
      }

      break;
    case 'mail_server':
      // abort processing if server details are missing (email, password or host)
      if(!systemVariable.getConfig('siteEmail') || !systemVariable.getConfig('siteEmailPassword') || !systemVariable.getConfig('siteEmailHost')){
        return callback(new Error('email not sent.  email server authentication missing'));
      }
      
      var server = email.server.connect({
        user: systemVariable.getConfig('siteEmail'),
        password: systemVariable.getConfig('siteEmailPassword'),
        host: systemVariable.getConfig('siteEmailHost'),
        port: systemVariable.getConfig('siteEmailPort') || null,
        ssl: typeof systemVariable.getConfig('siteEmailSSL') !== 'undefined' ? systemVariable.getConfig('siteEmailSSL') : false,
        tls: typeof systemVariable.getConfig('siteEmailTLS') !== 'undefined' ? systemVariable.getConfig('siteEmailTLS') : true,
        timeout: systemVariable.getConfig('siteEmailTimeout') || 5000
      });
      var receipientAddress = receipient.name ? receipient.name + ' <' + receipient.email + '>' : receipient.email;
      message = {
        text: text,
        from: sender.name + '<' + sender.email + '>',
        to: receipientAddress,
        subject: subject,
        cc: cc,
        attachment: attachment,
        "reply-to": replyAddress
      };

      // send email
      server.send(message, function(err, message){
        return callback(err, message);
      });   
      break;
  }
}


function _mandrillClientMessageSend(payload, clbk){
  let mandrill_client = new mandrill.Mandrill(systemVariable.getConfig('mandrillApiKey'));
  mandrill_client.messages.send({"message": payload, async: true}, 
    function(result){
      return clbk(null, payload);
    },
    function(err){
      return clbk(err, payload);
    });
}

/*
 * replace tokens in strings
 *
 * @param {string} message - message on which to perform token replacement
 * @param {object} req - current request object
 * @param {object} currentUser - (optional) basis for token replacements regarding current user. If user argument is not provided, the current session user is assumed to be the current user
 * @api public
 */
exports.tokenReplace = tokenReplace;
function tokenReplace(message, req, currentUser){
  // set user to currentUser if provided, otherwise use req.session.user (if exists), otherwise set to empty object
  var user = currentUser !== undefined ? currentUser : req.session.user;
  var token = _setToken(req, user);
  
  // replace all tokens in the message with translations 
  _.forEach(token, function(val, key){
    var re = new RegExp(utility.escapeRegExp(val.token), 'g');
    message = message.replace(re, val.translation);
  });
  
  return message;
}

// prepares token translations
function _setToken(req, user){
  var now = new Date();
  var token = {
    0: {token: '[date:current]', translation: now.toDateString()},
    1: {token: '[time:current]', translation: now.toTimeString()},
    2: {token: '[current-page:url]', translation: req.protocol + '://' + req.hostname + '/' + req.url},
    3: {token: '[current-page:url:path]', translation: req.url},
    4: {token: '[current-page:url:relative]', translation: '/' + req.url},
    5: {token: '[user:email]', translation: user.email},
    6: {token: '[user:name]', translation: user.name},
    7: {token: '[user:one-time-login-url]', translation: req.protocol + '://' + req.hostname + '/onetimelogin?email=' + encodeURIComponent(user.email) + '&link=' + encodeURIComponent(user.onetimelink)},
    8: {token: '[user:cancel-url]', translation: req.protocol + '://' + req.hostname + '/accountcancel?email=' + encodeURIComponent(user.email) + '&link=' + encodeURIComponent(user.onetimelink)},
    9: {token: '[user:one-time-email-verification-url]', translation: req.protocol + '://' + req.hostname + '/verifyemail?email=' + encodeURIComponent(user.email) + '&link=' + encodeURIComponent(user.onetimelink)},
    10: {token: '[site:name]', translation: systemVariable.getConfig('siteName')},
    11: {token: '[site:url]', translation: req.protocol + '://' + req.hostname},
    12: {token: '[site:login-url]', translation: req.protocol + '://' + req.hostname + '/login'}
  };
  
  return token;
}


/*
 * Keep a record of the user's url history (middleware)
 * this is used to perform url redirects to any previous locations
 * to use this as a regular function (as opposed to as middleware)
 * just pass in a fourth parameter, regularFunctionFlag, which can be anything
 *
 * @param {anything} regularFunctionFlag - indicates the function is not running as middleware
 * @api public
 */
exports.recordUrlHistory = recordUrlHistory;

function recordUrlHistory(regularFunctionFlag){
  // determine if this is middleware or a regular function call
  var middlewareFlag = typeof regularFunctionFlag === 'undefined' ? true : false;
  
  return function(req, res, next){
    // initialize the url record
    req.session.urlHistory = typeof req.session.urlHistory === 'object' ? req.session.urlHistory : [];
  
    // add the new url to the top of the urlHistory array
    req.session.urlHistory.unshift(req.originalUrl);
    if(middlewareFlag){return next();}
    return; 
  }
}


/*
 * Redirect user to a url in their previous history
 *
 * @param {number} steps - number of steps to go back in history (0 means current page)
 * @param {object} req - current request object
 * @param {object} res - current response object
 * @api public
 */
exports.redirectBack = redirectBack;

function redirectBack(steps, req, res){
  // if req.session.urlHistory does not exist or is empty, set to ['/']  
  req.session.urlHistory = typeof req.session.urlHistory !== 'object' ?  ['/'] : req.session.urlHistory.length === 0 ? ['/'] : req.session.urlHistory;
  res.redirect(req.session.urlHistory[steps]);
  return;
}


/*
 * Create and record URL aliases
 *
 * @param {array} resource - the array of resources for which the URL alias is being created
 *        Each element can be a Content object or any other object with the following parameters
 *          - url: proposed url alias.  This may be modified to ensure uniqueness.  For Content objects, the format
 *            should be 'contenttype/alias' where alias must be a string and not a number
 * @api public
 */
exports.recordUrlAlias = recordUrlAlias;

function recordUrlAlias(resource, callback){
  var asyncFn = [];
  
  resource.forEach(function(val, key){
    asyncFn.push(
      _prepAndPerformUrlUpdate.bind(val)
    );
  });

  async.series(asyncFn, function(err){
    return callback(err);
  });
}


function _prepAndPerformUrlUpdate(asyncCallback){
  // generate url alias if none exists
  this.url = this.url || '/' + this.contenttype + '/' + encodeURIComponent(this.title);
 
  // change space encoding from '%20' to '+'
  this.url = this.url.replace(/%20/g, '+');
  
  // generate static url (ie. the resource URL that never changes)
  var staticUrl;
  if(this.contenttype && this.id){
    staticUrl = '/' + this.contenttype + '/' + this.id;  // this is the case for a content object
  } else {
    staticUrl = this.url; // this is the case for a resource object since they cannot have aliases
  }
  
  // stop processing if there is no alias i.e. url is already contenttype/id
  var lastArray = this.url.split('/');
  var last = parseInt(lastArray[lastArray.length - 1], 10);
  if(this.id === last){return asyncCallback(null);}

  // check if alias is a number, return error if so
  if(!_.isNaN(last)){
    var error = new Error('A url alias cannot be a number');
    return asyncCallback(error);
  }

  // update alias record but first check if the alias already exists, modify it if so
  var aliasUpdate = {};
  aliasUpdate[this.url] = staticUrl;
  var alias = systemVariable.getConfig('alias');
  if(alias === null){alias = {};}
  
  // convert everything to lowercase
  var keyConvert = true;
  aliasUpdate = utility.convertCase(aliasUpdate, 'toLowerCase', keyConvert);
  alias = utility.convertCase(alias, 'toLowerCase', keyConvert);

  var aliasAndNewUrl = _insertUniqueAlias(aliasUpdate, alias);
  var newAliasConfig = aliasAndNewUrl[0]; // this is the object that is used to update system config
  var modifiedAliasUrl = aliasAndNewUrl[1]; // this is the final, unique alias for the resource
 
  // save the alias to database
  systemVariable.updateConfig({alias: newAliasConfig}, (function(err){
    if(err){return asyncCallback(err);}

    // update value of this.url
    this.url = modifiedAliasUrl;

    return asyncCallback(null);
  }).bind(this));
  
}


function _insertUniqueAlias(needle, haystack, iteration){
  iteration = ++iteration || 0;
  var nKey = Object.keys(needle)[0];
  
  // check if the nKey: url pair exists already in haystack, if so stop
  // if haystack contains url, delete the associated key, make nKey unique and add nKey: url
  // if nKey is not unique, make it unique and save
  
  // stop processing if needle is already in haystack
  if(haystack[nKey] === needle[nKey]){return [haystack, nKey];};
  
  // delete existing key from haystack, if the value of needle already exists
  if(_.contains(haystack, needle[nKey])){
    var hKey = null;
    _.forEach(haystack, function(val, key){
      if(val === needle[nKey]){hKey = key;}
    });
    
    delete haystack[hKey];
  }
  
  // make nKey unique
  var modifier;
  if(iteration > 0){
    modifier = nKey + '_' + iteration;
  } else {
    modifier = nKey;
  }
  
  // check if key modifier exists
  var flag = _.contains(Object.keys(haystack), modifier);
  
  // if haystack already has a similar key, then try again
  if(flag){
    return _insertUniqueAlias(needle, haystack, iteration);
  }
  
  haystack[modifier] = needle[nKey];
  return [haystack, modifier];
}


/*
 * Run cron tasks
 * 
 * @param {obj} req - express request object
 * @param {obj} res - express response object
 * @api public
 */
exports.runCron = runCron;

function runCron(req, res, callback){
  var asyncFn = {};  // will contain all functions to be run during cron
  let tasksDue = {}  // will contain all the functions to be run during cron
  , cronRecord = systemVariable.getConfig('cronRecord')
  , cronTask = systemVariable.get('cronTask')
  , now = Date.now()
  , temp = []
  ;

  // check which tasks are due 
  _.forEach(cronRecord.task, function(taskDescription, taskName){
    let lastrun = taskDescription.lastrun;
    let freq = taskDescription.freq;

    if((lastrun === null || now - lastrun >= freq*60*1000) && freq !== 0 ){
      /* just in case somehow cronTask and cronRecord are out of sync, check if the respective
       * task exists in cronTask before adding it to the list.  should not be necessary but......
       */
      if(cronTask[taskName]){
        tasksDue[taskName] = cronTask[taskName];
      }
    }
  });

  // stop processing if there are no tasks due to run
  if(!Object.keys(tasksDue).length){return callback();}


  function makeArray(target){
    let temp = [];
    _.forEach(target, function(val, key){
      temp.push(val(req, res, key));
    });

    return temp;
  }

  Promise.all(makeArray(tasksDue))
  .then(function(cronTaskResults){
    return new Promise(function(resolve, reject){

      // update cron record
      let cronRecordUpdate = systemVariable.getConfig('cronRecord');

      cronTaskResults.forEach(function(cronTaskResult){
        // if cron task executed without errors, update the last run time
        if(!cronTaskResult.err){
          cronRecordUpdate.task[cronTaskResult.id].lastrun = Date.now();
        }
      });

      systemVariable.updateConfig({cronRecord: cronRecordUpdate}, function(err){  
        if(err){ return reject(err); }

        return resolve(cronTaskResults);
      });

    });
  })
  .then(function(cronTaskResults){
    // log results
    let logs = [];
    cronTaskResults.forEach(function(result){
      logs.push({
        type: result.err ? 'warn' : 'info',
        category: 'system',
        message: result.message
      });
    });

    logs.forEach(function(log){
      logger.record(log.type, {req: req, category: log.category, message: log.message});
    });

    return callback(null);
  });
} 


/*
 * Add tasks to cron
 * NOTE: task names are unique.  To prevent accidentally clobbering an existing task, prefix cron task names with
 * the name of your app module e.g. 'mycoolapp send email newsletter'.
 * 
 * Cron is maintained in two separate places in systemVariable; cronTask and config.cronRecord.  
 * cronTask is formatted as {'task name': task function}.  This information is not persisted in the database and 
 * must be reset each time the application is restarted
 * cronRecord is formatted as {task name: {freq: frequency, lastrun: time last run}}.  This information is stored in
 * the database and is retrieved each time the app is started
 * Obviously cronTask and cronRecord must be kept in sync.  This is done by functions addCronTask and deleteCronTask
 * 
 * @param {string} taskName - unique name to identify task. use human recognizable name e.g. 'nightly backup'
 * @param {function} task - task to be run.
 *     - pass as 'null' if just updating the frequency
 *     - task will be run as task.bind(null, req, res)(callback)
 *     - task needs to return callback(null, {err: <any error>, key1: <string>, key2: <string>})
 *     - err should contain error objects
 *     - if no err, then there must be at least one key/value pair returned e.g. {'newsletter': 'sent succesfully'}
 * @param {string / integer} freq - frequency at which the task needs to be run.  specified in minutes (also accepts
   'hourly', 'daily', 'weekly')
 * @api public
 */
exports.addCronTask = addCronTask;

function addCronTask(taskName, task, freq, callback){
  var lastrun = null;  // default value of lastrun
  // check if freq is a string or an integer
  if(typeof freq === 'string'){
    switch(freq){
      case 'hourly':
        freq = 60*60;
        break;
      case 'daily':
        freq = 60*60*24;
        break;
      case 'weekly':
        freq = 60*60*24*7;
        break;
      default:
        var err = new Error('frequency not recognized');
        return callback(err);
    }
  }
  
  // set cronTask with the details of the new cron task
  var newCronTask = systemVariable.get('cronTask');
  newCronTask[taskName] = task || newCronTask[taskName]; // keep existing function if none (null) is specified
  systemVariable.set('cronTask', newCronTask);
  
  // get existing cronRecord
  var newCronRecord = systemVariable.getConfig('cronRecord');
  newCronRecord.task[taskName] = newCronRecord.task[taskName] || {};
  newCronRecord.task[taskName].freq = freq;
  newCronRecord.task[taskName].lastrun = newCronRecord.task[taskName].lastrun || null;  // use existing last run value, if it exists
  
  // update cronRecord
  systemVariable.updateConfig({cronRecord: newCronRecord}, function(err){
    return callback(err);
  });

}


/*
 * Remove cron task
 *
 * @param {string} taskName - name of cron task to be removed
 * @api public
 */
exports.deleteCronTask = deleteCronTask;

function deleteCronTask(taskName, callback){
  var oldCronRecord = systemVariable.getConfig('cronRecord');
  // if the cron task does not exist, then do nothing
  if(typeof oldCronRecord.task[taskName] === 'undefined'){return callback(new Error('No cron task with this name exists'));}
  delete oldCronRecord.task[taskName];
  systemVariable.updateConfig({cronRecord: oldCronRecord}, function(err){
    if(err){return callback(err);}
    // remove cronTask
    var oldCronTask = systemVariable.get('cronTask');
    delete oldCronTask[taskName];
    systemVariable.set('cronTask', oldCronTask);
    callback(null);
  });
}


/*
 * Backup database
 *
 * @api public
 */
exports.backupDatabase = backupDatabase;

function backupDatabase(req, res, id){
  return new Promise(function(resolve, reject){

    // prep backup file name
    var now = new Date();
    var year = now.getFullYear();
    var month = now.getMonth() + 1;
    month = month < 10 ? '0' + month.toString() : month.toString();
    var day = now.getDate();
    day = day < 10 ? '0' + day.toString() : day.toString();
    var hour = now.getHours();
    hour = hour < 10 ? '0' + hour.toString() : hour.toString();
    var minute = now.getMinutes();
    minute = minute < 10 ? '0' + minute.toString() : minute.toString();
    var second = now.getSeconds();
    second = second < 10 ? '0' + second.toString() : second.toString();
    
    var re = /\s/g;
    var siteName = systemVariable.getConfig('siteName').replace(re, '_');
    var backupFileName = 'backup_' + siteName;
    backupFileName += '_' + year + month + day + hour + minute + second + '.sql';
    var backupFilePath = path.join(handyDirectory, 'tmp');
    
    var asyncFn = [
    _dumpDatabase,
    _gzipBackupFile
    ];
    
    
    switch(systemVariable.getConfig('backupDestinationType')){
      case 'email':
        asyncFn.push(_mailBackupFile);
        break;
      case 'file':
        asyncFn.push(_copyBackupFile);
        break;
    }
    
    asyncFn.push(_deleteBackupFile);
    
    async.series(asyncFn, function(err, results){
      let finalResult = {
        err: err,
        id: id,
        message: err ? 'error backing up the database' : 'database backup successfull'
      };

      return resolve(finalResult);  // return format for functions designed to be run under cron
    });
    
    
    function _dumpDatabase(asyncCallback){
      // prepare linux command to dump database
      var credentials = '-u ' + systemVariable.get('databaseUser') + ' -p' + systemVariable.get('databasePassword');
      var backupCommand = 'mysqldump ' + credentials + ' ' + systemVariable.get('database') + ' > ' + path.join(backupFilePath, backupFileName);
    
      // create backup file
      var child = exec(backupCommand, function(err, stdout, stderr){
        if(err){
          return asyncCallback(err);
        }
        return asyncCallback();
      }); 
    }
    
    function _gzipBackupFile(asyncCallback){
      // gzip the database dump
      var gzipCommand = 'gzip ' + path.join(backupFilePath, backupFileName);
      var child = exec(gzipCommand, function(err, stdout, stderr){
        if(err){
          return asyncCallback(err);
        }
        backupFileName += '.gz';  // add gzip file extension to backup file name
        return asyncCallback()
      });
    }
    
    function _mailBackupFile(asyncCallback){
      var receipient = {email: systemVariable.getConfig('backupDestination')};
      var sender = {name: systemVariable.getConfig('siteName'), email: systemVariable.getConfig('siteEmail')};
      var subject = '[' + systemVariable.getConfig('siteName') + '] Backup ' + year + month + day + hour + minute + second;
      var body = {text: 'Database backup\n\nSite name: ' + systemVariable.getConfig('siteName') + '\nBackup time: ' + month + '/' + day + '/' + year + ' - ' + hour + ':' + minute + ':' + second};
      var attachment = [{
            name: backupFileName,
            type: 'application/gzip',
            path: path.join(backupFilePath, backupFileName)
          }];

      sendEmail(receipient, sender, subject, body, null, attachment, null, function(err){
        return asyncCallback(err);
      });
    }

    function _copyBackupFile(asyncCallback){
      // cbCalled is needed because if there is an error in the pipe statement
      // an error is thrown in both read and write streams leading to the callback
      // being executed twice if not dealt with
      var cbCalled = false; 

      let destination = systemVariable.getConfig('backupDestination');
      let source = path.join(backupFilePath, backupFileName);

      let read = fs.createReadStream(source);
      read.on('error', function(err){
        done(err);
      });

      let write = fs.createWriteStream(destination);
      write.on('error', function(err){
        done(err);
      });
      write.on('close', function(ex){
        done();
      });

      read.pipe(write);

      function done(err){
        if(!cbCalled){
          asyncCallback(err);
          cbCalled = true;
        }
      }
    }

    function _deleteBackupFile(asyncCallback){
      let target = path.join(backupFilePath, backupFileName);
      fs.unlink(target, asyncCallback());
    }


  });
}


/*
 * Prepare pageInfo object for use in GET responses and perform any tasks common to all GETs
 * NOTE: Because this function moves the system messages from req.session.msgCache to res.locals.sysmessage,
 *       if there is a need to redirect afterwards, system messages NEED to be moved back to req.session.msgCache
 *       otherwise they will be lost as res.redirect creates a new res object.  Use restoreSystemMessage to preserve
 *       the system messages
 *
 * @param {object} option - custom information for this particular request.  is in the form {info:<info_option>, action:<action_option>}
 * @param {object} req - express request object
 * @param {object} res - express response object
 * @api public
 */
exports.prepGetRequest = prepGetRequest;

function prepGetRequest(option, req, res, callback){
  // check if installation is required
  if(!systemVariable.get('installation_flag')){
    res.redirect('/install');
    var err = new Error('installation required');
    return callback(err);
  }

  // default information
  var pageInfo = {
    title: null,
    config: systemVariable.get('config'),
    user: req.session.user || {},
    siteinfo: {protocol: req.protocol, host: req.hostname, path: req.path, query: req.query, url: req.url},
    googleAnalyticsCode: systemVariable.getConfig('googleAnalyticsId'),
    templateDefault: systemVariable.getConfig('themeTemplateDefault'),
    other: {},
  };

  // update custom information
  _.forEach(option.info, function(val, key){
    pageInfo[key] = val;
  });
  
  // default actions
  recordUrlHistory(true)(req, res);  // record url history
  
  // perform custom actions
  _.forEach(option.action, function(val, key){
    val;
  });
  
  // make any late breaking system messages available for display
  res.locals.sysmessage = res.locals.sysmessage || {};
  var msg = systemMessage.get(req);
  _.forEach(msg, function(txt, type){
    res.locals.sysmessage[type] = res.locals.sysmessage[type] || [];
    res.locals.sysmessage[type] = res.locals.sysmessage[type].concat(txt);
  });
  
  return callback(null, pageInfo);
}


/*
 * Define system logging
 *
 * @params {string} level - type of log level ('info', 'warn', 'error')
 *   info - regular site operations e.g. GET requests successfully satisfied
 *   warn - irregular activity e.g. 404 error, login failure
 *   error - system error e.g. database read error, 
 * @params {object} record - log object
 *   format: logObject = {req: <express req object>, category: <log category e.g. "user" or "cron">, message: <descriptive message>), 
 *           if logging an error, format is logObject = {error: <error object>, message: <description>}
 * @params {string/int} period (optional) - period for which the log report will cover 
 *   format: (integer representing age in hours or string options 'hourly', 'daily', 'weekly', 'monthly')
 *           if ommitted, period will use the systemVariable value of 'reportFreq'
 * @api public
 */

var logger = {
  log: null,

  start: function(){
    var siteName = systemVariable.getConfig('siteName');
    this.path = path.join(handyDirectory, 'logs', siteName.toLowerCase().replace(/ /g, '-') + '.log');
    this.log = bunyan.createLogger({
      name: siteName,
      streams: [
        {
          level: 'info',
          path: this.path,
          type: 'rotating-file',
          period: '1w',
          count: 3
        }
      ]
    });
  },

  record: function(level, record){
    /* this function is written very defensively i.e. it is designed to not generate any errors
     * regardless of what is thrown at it.  It would rather drop log messages than crash hence it
     * is a bit more verbose than normal
     */

    // stop processing if logger is not started
    if(!this.log){return;}

    // stop processing if no log record or log record is not an object
    if(!record || typeof record !== 'object'){return;}

    // set defaults
    level = level || 'info';
    record.req = record.req || {};
    record.req.headers = record.req.headers || {};
    record.req.session = record.req.session || {};
    record.req.session.user = record.req.session.user || {};
    record.message = record.message || '';
    record.category = record.category || 'system';
    record.error = record.error || {};
    record.time = new Date(Date.now()).toString();

    // get log details from req (if not an Error log)
    if(level.toLowerCase() !== 'error'){
      var ip = record.req.header('x-forwarded-for') || record.req.connection.remoteAddress;  // get ip address from nginx proxy
      var url = record.req.originalUrl;
      var method = record.req.originalMethod;
      var referer = record.req.headers.referer || '';
      var category = record.category;
      var userId = record.req.session.user.id || 0;
      var time = record.time;
      var options = {ip: ip, url: url, method: method, referer: referer, category: category, userId: userId, time: time};
    }

    // switch to the right log level and record log message
    switch(level.toLowerCase()){
      case 'info':
        this.log.level('info');
        this.log.info(options, record.message);
        break;
      case 'warn':
        this.log.level('warn');
        this.log.warn(options, record.message);
        break;
      case 'error':
        this.log.level('error');
        this.log.error(record.error, record.message);
        break;
      default:
        this.log.level('info');
        this.log.info(options, record.message);
    }
    return;
  },

  report: function(req, res, id, period){
    return new Promise(function(resolve, reject){
      // 'this' cannot be trusted because when this function is called
      // during cron, the value of 'this' is undefined so we use 'self' instead
      var self = {};  // 
      period = period || systemVariable.getConfig('reportFreq');

      // for some reason, this.path is not persisted on cron calls so need to recalculate it
      var siteName = systemVariable.getConfig('siteName');
      self.path = path.join(handyDirectory, 'logs', siteName.toLowerCase().replace(/ /g, '-') + '.log');

      // read log files and consolidate events into report to be sent to the administrator
      var stream = fs.createReadStream(self.path, {encoding: 'utf-8'});
      var now = Date.now();  // time right now in milliseconds
      var buf = '';
      var line;
      self.logReport = {};  // will contain the final report as an object formated as {sitename: {level: {category: {other details}}}}

      // find the time for the oldest possible entry allowed in the report
      var age = parseInt(period) * 60 * 60 * 1000;  // age in milliseconds
      if(isNaN(age)){
        switch(period.toLowerCase()){
          case 'hourly':
            age = 1000 * 60 * 60; 
            break;
          case 'daily':
            age = 1000 * 60 * 60 * 24;
            break;
          case 'weekly':
            age = 1000 * 60 * 60 * 24 * 7;
            break;
          case 'monthly':
            age = 1000 * 60 * 60 * 24 * 31;
            break;
          default:
            age = 1000 * 60 * 60 * 24;  // default is one day
            break;
        }
      }

      // timestamp, in milliseconds, of the oldest report (subtracting one millisecond so as to catch events that happen
      // at the same time as the last report generation e.g. if both report and event happen on the same cycle)
      var oldest = now - age - 1;

      stream.on('data', (function(chunk){
        buf += chunk.toString();
        sliceLine.bind(this)();  // slice stream into lines
      }).bind(self));

      stream.on('end', (function(){
        designReport.bind(this)();  // make the report visually pleasing
        sendReport.bind(this)();  // if all the logs have been processed, then send the report
      }).bind(self));

      // slice stream into individual lines
      function sliceLine(){
        var pos = buf.indexOf('\n');
        if(pos === 0){buf = buf.substr(1, buf.length-1)};  // if line starts with newline, delete newline
        
        // if there is a newline, slice the text before  
        if(pos > 0){
          var line = buf.substr(0, pos);
          processLine.bind(this, line)();
          buf = buf.substr(pos+1, buf.length-1);
          sliceLine.bind(this)(); // check again to see if there is another line in the buffer
        }

        return;
      }

      // process each line
      function processLine(stringJSON){
        // each line should be a JSON object in string format
        var lineJSON = JSON.parse(stringJSON);

        // stop processing lines older than the requested period
        if(Date.parse(lineJSON.time) - oldest < 0){return;}

        // convert log levels to text (default is info)
        switch(lineJSON.level){
          case 10:
            lineJSON.level = 'trace';
            break;
          case 20:
            lineJSON.level = 'debug';
            break;
          case 30:
            lineJSON.level = 'info';
            break;
          case 40:
            lineJSON.level = 'warn';
            break;
          case 50:
            lineJSON.level = 'error';
            break;
          case 60:
            lineJSON.level = 'fatal';
            break;
          default:
            lineJSON.level = 'info';
            break;
        }

        // add lineJSON into the report
        this.logReport[lineJSON.name] = this.logReport[lineJSON.name] || {}
        this.logReport[lineJSON.name][lineJSON.level] = this.logReport[lineJSON.name][lineJSON.level] || {};
        this.logReport[lineJSON.name][lineJSON.level][lineJSON.category] = this.logReport[lineJSON.name][lineJSON.level][lineJSON.category] || [];
        var tempObject = {};
        this.attributeArray = ['ip', 'url', 'method', 'referer', 'userId', 'msg', 'time', 'err'];  // list of attributes to record in report
        this.attributeArray.forEach(function(val){
          if(lineJSON[val] !== undefined){tempObject[val] = lineJSON[val]}
        });
        this.logReport[lineJSON.name][lineJSON.level][lineJSON.category].push(tempObject);
      }

      function designReport(){
        // converts the report into an html table format
        this.htmlReport = '';

        // set up html email header
        var designReport = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">';
        designReport += '<html xmlns="http://www.w3.org/1999/xhtml">';
        designReport += '<head>';
        designReport += '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />';
        designReport += '<title></title>';
        designReport += '<style></style>';
        designReport += '</head>';
        designReport += '<body>';

        designReport += '<table border="0" cellpadding="0" cellspacing="0" height="100%" width="100%" id="bodyTable">';
        designReport += '<tr>';
        designReport += '<td align="center" valign="top">';
        designReport += '<table border="0" cellpadding="20" cellspacing="0" width="800" id="emailContainer">';
        designReport += '<tr>';
        designReport += '<td align="left" valign="top">';

        _.forEach(this.logReport, function(siteReport, siteName){
          designReport += '<h3>' + siteName + ' activity report</h3><br/><br/>';
        //designReport += systemVariable.getConfig('siteName') +' activity report<br/><br/>';
        designReport += '<strong>Start:</strong> ' + new Date(oldest).toString() + '<br/>';
        designReport += '<strong>End:</strong> ' + new Date(now).toString() + '<br/><br/>';
        
          _.forEach(siteReport, function(levelReport, level){
            _.forEach(levelReport, function(report, source){
              designReport += '<table border="1" cellpadding="0" cellspacing="0" height="100%" width="100%" id="reportTable">';
              designReport += '<caption style="text-align:left;"><h4>Level - ' + level.substr(0,1).toUpperCase() + level.substr(1) + '</h4></caption>';

              // log type
              designReport += '<tr>';
              designReport += '<td colspan="' + this.attributeArray.length + '"><h4>' + source + '</h4></td>';
              designReport += '</tr>';

              // table headers
              designReport += '<tr>';
              this.attributeArray.forEach(function(attribute){
                designReport += '<th>' + attribute + '</th>';
              });
              designReport += '</tr>';         

              report.forEach((function(reportObject){
                designReport += '<tr>';
                this.attributeArray.forEach(function(attribKey){
                  // insert blank cell if attribute is not present
                  designReport += (reportObject[attribKey] !== undefined) ? '<td>' + reportObject[attribKey] + '</td>' : '<td></td>';
                });
                designReport += '</tr>';
              }).bind(this));

              designReport += '</table>';
              designReport += '<br/><br/>';
            }, this);

            designReport += '<br/><br/>';
          }, this);
        }, this);

        designReport += '</td>';
        designReport += '</tr>';
        designReport += '</table>';
        designReport += '</td>';
        designReport += '</tr>';
        designReport += '</table>';
        // close html email
        designReport += '</body>';
        designReport += '</html>';

        this.htmlReport = designReport;
        return;
      }

      function sendReport(){
        var receipient = {email: systemVariable.getConfig('reportDestination')};
        var sender = {name: systemVariable.getConfig('siteName'), email: systemVariable.getConfig('siteEmail')};
        var subject = '[' + systemVariable.getConfig('siteName') + '] Activity Report';
        var body = {text: this.htmlReport, html: this.htmlReport};

        sendEmail(receipient, sender, subject, body, null, null, null, function(err){
          let finalResult = {
            err: err,
            id: id,
            message: !err ? 'activity report sent successfully' : 'error sending activity report'
          };

          return resolve(finalResult);

        });
      }


    });
  }
}

exports.logger = logger;


/*
 * Express Error Handler
 *
 * @param {object} err - express error object
 * @param {object} req - express request object
 * @param {object} res - express response object
 * @param {object} next - express next object
 * @api public
 */
exports.errorHandler = errorHandler;

function errorHandler(err, req, res, next){
  console.log('err stack is \n', err.stack);
  var logDetail;  // will contain the details of the log record
  switch (err.status){
    case 403:
      prepGetRequest({
        info: {title: 'Access denied'},
        action: []
      }, req, res, function(err, pageInfo){
        if(err){logger.record('error', {error: err, message: 'errorHandler - prepGetRequest'}); return;}

        res.status(403);
        logDetail = {type: 'warn', category: 'content', message: 'display 403 access denied page'};
        display(req, res, '403accessdenied', pageInfo, logDetail);
      });
      return;
      break;

    case 500:
      prepGetRequest({
        info: {title: 'Internal error'},
        action: []
      }, req, res, function(err, pageInfo){
        if(err){logger.record('error', {error: err, message: 'errorHandler - prepGetRequest'}); return;}

        res.status(500);
        logDetail = {type: 'warn', category: 'content', message: 'display 500 internal error page'};
        display(req, res, '500internalerror', pageInfo, logDetail);
      });
      return;
      break;

    default:
      prepGetRequest({
        info: {title: 'Internal error'},
        action: []
      }, req, res, function(err, pageInfo){
        if(err){logger.record('error', {error: err, message: 'errorHandler - prepGetRequest'}); return;}

        res.status(500);
        logDetail = {type: 'warn', category: 'content', message: 'display 500 internal error page'};
        display(req, res, '500internalerror', pageInfo, logDetail);
      });
      return;
      break;
  }
}


/*
 * Display page
 * diplay a page using the theme settings
 * 
 * @param {object} req - express request object
 * @param {object} res - express response object
 * @param {string} view - jade view file
 * @param {object} locals - variables for display
 * @param {object} logDetail - data to be written to log
 * @api public
 */
exports.display = display;

function display(req, res, view, locals, logDetail){
  // initialize logDetail
  logDetail = logDetail || {};
  logDetail.type = logDetail.type || '';
  logDetail.category = logDetail.category || '';
  logDetail.message = logDetail.message || '';

  /* 
   * list of pageInfo variables to set
   * pageInfo.theme.head, pageInfo.theme.section_header, pageInfo.theme.messages, pageInfo.theme.section_footer
   * pageInfo.theme.section_bottomscripts, pageInfo.theme.section_extras
   *
   * list of translation tokens
   * [theme_title], [theme_description], [theme_canonical], [theme_sitename], [theme_login_logout], [theme_messages], [theme_ga], [theme_tinymce]
   */

   // allow programatic modification of themes i.e. display will use the theme template passed 
   // in pageInfo.theme or use the default if none is provided
   var template = locals.theme || systemVariable.getConfig('theme');

   var pageInfo = locals || {};  // set the locals that will be passed to the jade view
   pageInfo.theme = pageInfo.theme || {};
   pageInfo.themeTemplate = template;  // this is the still tokenized version of the template ie. without the token replacements

   // list of individual sections of the template
   var pageSections = ['head', 'section_header', 'section_messages', 'section_footer', 'section_bottomscripts', 'section_extras'];
   pageSections.forEach(function(section){
    pageInfo.theme[section] = _tokenReplace(template[section]);
   });

   // display page
   res.render(view, {pageInfo: pageInfo});

   // log event
   logger.record(logDetail.type, {req: req, category: logDetail.category, message: logDetail.message});
   return;

  function _tokenReplace(message){
    message = message || '';  //initialize message in case undefined is passed in

    // determine user roles eg is the user a site admin and/or an org admin
    let isOrgAdmin = false
    , isSiteAdmin = false
    ;
    if(req.session.user.role){
      req.session.user.role.forEach(function(role){
        role === 'org_admin' ? isOrgAdmin = true : null;
        role === 'administrator' ? isSiteAdmin = true : null;
      });      
    }

    let logoutLink = '<li class="dropdown">';
    logoutLink += '<a href="#" class="dropdown-toggle" data-toggle="dropdown" role="button" aria-expanded="false">' + req.session.user.name + '<span class="caret"></span>';
    logoutLink += '<ul class="dropdown-menu" role="menu">';
    logoutLink += '<li><a href="/user">My Account</a></li>';
    logoutLink += isOrgAdmin ? '<li><a href="/organization/manage">My organization</a></li>' : '' ;
    logoutLink += isSiteAdmin ? '<li><a href="/configuration">Site configuration</a></li>' : '' ;
    logoutLink += '<li><a href="/logout">Logout</a></li>';
    logoutLink += '</ul></li>';

    var translation = {
      'theme_title': '<title>' + locals.title + '</title>',
      'theme_description': (locals.description !== undefined) ? '<meta name="description" content="' + locals.description + '">' : "",
      'theme_canonical': (locals.canonical !== undefined) ? '<link rel="canonical" href="' + locals.canonical + '"/>' : "",
      'theme_sitename': systemVariable.getConfig('siteName'),
      'theme_login-logout': (locals.user.authenticated === true) ? logoutLink : '<li><a href="/login">Login</a></li> ',
      'theme_messages': _prepMessages(req, res),
      'theme_ga': _prepGA(locals.googleAnalyticsCode),
      'theme_tinymce': (locals.tinymce === true) ? '<script src="/js/tinymce.min.js"></script>\n\t<script src="/js/tinymce.config.js"></script>' : "",
    };

    var re, token;
    _.forEach(translation, function(output, input){
      token = utility.escapeRegExp('[' + input + ']');
      re = new RegExp(token, 'g');
      message = message.replace(re, output);
    });

    return message;
  }

  // prepare system messages in suitable format for theme
  function _prepMessages(req, res){
    // make all system messages available for display
    res.locals.sysmessage = res.locals.sysmessage || {};
    var msg = systemMessage.get(req);
    _.forEach(msg, function(txt, type){
      res.locals.sysmessage[type] = res.locals.sysmessage[type] || [];
      res.locals.sysmessage[type] = res.locals.sysmessage[type].concat(txt);
    });

    var sysmessage = '<div class="container-fluid">';
    _.forEach(res.locals.sysmessage, function(arr, type){
      sysmessage += _appendAlert(arr, type);
    });
    sysmessage += '\t</div><!--container-fluid-->';

    return sysmessage;
  }

  function _appendAlert(arr, type){
    var messageFragment = '';

    switch(type){
      case 'success':
        messageFragment += '<div class="alert alert-dismissable fade in alert-success spacer">';
        messageFragment += '<button class="close" type="button" data-dismiss="alert"> &times;</button>';
        messageFragment += '<h4>Cool</h4>';
        arr.forEach(function(msgx){
          messageFragment += '<p>' + msgx + '</p>';
        });
        messageFragment += '</div><!--alert-->';
        break;
      case 'warning':
        messageFragment += '<div class="alert alert-dismissable fade in alert-warning spacer">';
        messageFragment += '<button class="close" type="button" data-dismiss="alert"> &times;</button>';
        messageFragment += '<h4>Caution!</h4>';
        arr.forEach(function(msgx){
          messageFragment += '<p>' + msgx + '</p>';
        });
        messageFragment += '</div><!--alert-->';
        break;
      case 'danger':
        messageFragment += '<div class="alert alert-dismissable fade in alert-danger spacer">';
        messageFragment += '<button class="close" type="button" data-dismiss="alert"> &times;</button>';
        messageFragment += '<h4>Oops!</h4>';
        arr.forEach(function(msgx){
          messageFragment += '<p>' + msgx + '</p>';
        });
        messageFragment += '</div><!--alert-->';
        break;
      case 'dev':
        messageFragment += '<div class="alert alert-dismissable fade in alert-info spacer">';
        messageFragment += '<button class="close" type="button" data-dismiss="alert"> &times;</button>';
        messageFragment += '<h4>System message</h4>';
        arr.forEach(function(msgx){
          messageFragment += '<p>' + msgx + '</p>';
        });
        messageFragment += '</div><!--alert-->';
        break;
      default:
        messageFragment += '<div class="alert alert-dismissable fade in alert-' + type + ' spacer">';
        messageFragment += '<button class="close" type="button" data-dismiss="alert"> &times;</button>';
        messageFragment += '<h4>' + type + '</h4>';
        arr.forEach(function(msgx){
          messageFragment += '<p>' + msgx + '</p>';
        });
        messageFragment += '</div><!--alert-->';
    }

    return messageFragment;
  }

  function _prepGA(ga_code){
    var ga_script = '';

    // stop processing if no google analytics code is present
    if(ga_code === '' && ga_code === undefined && ga_code === null){
      return ga_script;
    }

    ga_script += '<!--google analytics-->';
    ga_script += '<script async src="//www.google-analytics.com/analytics.js"></script>';
    ga_script += '<script>\n';
    ga_script += '\twindow.ga=window.ga||function(){(ga.q=ga.q||[]).push(arguments)};ga.l=+new Date;\n';
    ga_script += '\tga("create", "' + ga_code + '", "auto");\n';
    ga_script += '\tga("send", "pageview");\n'
    ga_script += '</script>\n';
    ga_script += '<!--End google analytics-->';

    return ga_script;
  }
}


/*
 * Get the name of an organization
 * 
 * @param {int} id - id of the organization
 * @api public
 */
exports.getOrganizationName = getOrganizationName;

function getOrganizationName(id, callback){

  let notFoundResult = '';  // this is the value that will be returned if the organization is not found
  if(!_.isNumber(id)){ return callback(notFoundResult); }  // stop processing if not a number

  const pool = systemVariable.get('pool');
  pool.getConnection(function(err, connection){
    if(err){ return callback(notFoundResult); }

    let query = 'SELECT name FROM organization ';
    query += 'WHERE id = ' + connection.escape(id);

    connection.query(query, function(err, results){
      if(err || !results.length){ return callback(notFoundResult); }
      return callback(results[0].name);
    });
  });

}


/*
 * Create a record for a new organization
 * NOTE: Returns an error if the organization already exists
 * 
 * @param {string} org - new organization being created
 * @api public
 */
exports.createNewOrganization = createNewOrganization;

function createNewOrganization(org){
  return new Promise(function(resolve, reject){
    checkRecordIsUnique('organization', 'name', org)
    .then(function(isUnique){
      if(!isUnique){ return reject(new Error('an organization with the name ' + org + ' already exists')); }

      const pool = systemVariable.get('pool');
      const role = [];
      pool.getConnection(function(err, connection){
        if(err){ return reject(err); }
        let query = 'INSERT INTO organization(name, status) VALUES(';
        query += connection.escape(org) + ', ' + connection.escape(JSON.stringify(role)) + ')';
        connection.query(query, function(err, results){
          if(err){ return reject(err); }
          return resolve(results.insertId);
        });
      });
    })
    .catch(function(err){
      return reject(err);
    });
  });
}


/*
 * Check if a record is unique
 * 
 * @param {string} table - table being checked
 * @param {string} column - column being checked
 * @param {string} record - record being checked for uniqueness
 * @api public
 */
exports.checkRecordIsUnique = checkRecordIsUnique;

function checkRecordIsUnique(table, column, record){
  return new Promise(function(resolve, reject){
    const pool = systemVariable.get('pool');
    table = table.toLowerCase();
    column = column.toLowerCase();

    let query = 'SELECT * FROM ' + mysql.escapeId(table);
    query += ' WHERE ' + mysql.escapeId(column) + ' = ' + mysql.escape(record);
    pool.getConnection(function(err, connection){
      if(err){ return reject(err); }
      connection.query(query, function(err, results){
        connection.release();
        if(err){ return reject(err); }
        let isUnique = results.length ? false : true;
        return resolve(isUnique);
      });
    })
  });
}


/*
 * Form validation
 *
 * @param {string} formType - type of form being validated e.g. userLogin, passReset, etc.  
 * Can also be a callback function to execute custom validation
 * @param {req} Express request object
 * @param {res} Express response object
 * @param {next} Express next object
 */
exports.validateForm = validateForm;

function validateForm(formType){
  return function(req, res, next){
    
    /* do not perform validation on forms where the action is delete.  
     * This is because these forms do not send back any form input and
     * so there is no data to validate
     */
    if(req.params.action === 'delete'){next(); return;}

    var validateObject = {}; // will contain the validation parameters for the form inputs
    
    switch (formType){
      case 'testValidation':
        // this is only used to run unit tests
        validateObject = req.validateObject;
        break;
      case 'userLogin':
        validateObject['Email'] = {
          value: req.body.userEmail,
          required: true,
          type: 'email',
        };
        validateObject['Password'] = {
          value: req.body.userPassword,
          required: true,
          type: 'password',
          confirmation: true
        };
        break;
      case 'passResetRequest':
        validateObject['Email'] = {
          value: req.body.userEmail,
          required: true,
          type: 'email',
        };
        break;
      case 'userRegister':
        validateObject['Email'] = {
          value: req.body.userEmail,
          required: true,
          type: 'email',
        };
        validateObject['Password'] = {
          value: req.body.userPassword,
          required: false,
          type: 'password',
          confirmation:  req.body.userPassword === req.body.userPasswordConf
        };  
        break;
      case 'orgRegister':
        validateObject['Email'] = {
          value: req.body.userEmail,
          required: true,
          type: 'email',
        };
        validateObject['Organization'] = {
          value: req.body.orgName,
          required: true,
          type: 'text',
        };
        validateObject['Password'] = {
          value: req.body.userPassword,
          required: false,
          type: 'password',
          confirmation:  req.body.userPassword === req.body.userPasswordConf
        };  
        break;
      case 'orgUserProvision':
        validateObject['Email List'] = {
          value: req.body['orguserprovisionlist'],
          required: true,
          type: 'text'
        };
        break;
      case 'siteInstall':
        validateObject['site name'] = {
          value: req.body.siteName,
          required: true,
          type: 'text',
        };
        validateObject['site email'] = {
          value: req.body.siteEmail,
          required: true,
          type: 'email',
        };
        validateObject['Database name'] = {
          value: req.body.dbName,
          required: true,
          type: 'text',
        };
        validateObject['Database user'] = {
          value: req.body.dbUser,
          required: true,
          type: 'text'
        };
        validateObject['Database password'] = {
          value: req.body.dbPassword,
          required: true,
          type: 'password',
          confirmation: true
        };
        validateObject['Admin name'] = {
          value: req.body.adminName,
          required: true,
          type: 'text',
        };
        validateObject['Admin email'] = {
          value: req.body.adminEmail,
          required: true,
          type: 'email',
        };
        validateObject['Admin password'] = {
          value: req.body.adminPassword,
          required: true,
          type: 'password',
          confirmation: req.body.adminPassword === req.body.adminPasswordConf
        };
        break;
      case 'passwordChange':
        validateObject['Old password'] = {
          value: req.body.oldPassword,
          required: false,
          type: 'password',
          confirmation: true
        };
        validateObject['New password'] = {
          value: req.body.newPassword,
          required: true,
          type: 'password',
          confirmation: req.body.newPassword === req.body.newPasswordConf
        };        
        break;
      case 'configGeneral':
        validateObject['Site name'] = {
          value: req.body.siteName,
          required: true,
          type: 'text',
        };
        validateObject['Site email'] = {
          value: req.body.siteEmail,
          required: true,
          type: 'email',
        };
        validateObject['Default front page'] = {
          value: req.body.defaultFrontPage,
          required: false,
          type: 'text',
        };
        validateObject['Welcome page'] = {
          value: req.body.welcomePage,
          required: false,
          type: 'text',
        };
        validateObject['Default 404 page'] = {
          value: req.body.default404Page,
          required: false,
          type: 'text',
        };
        validateObject['Default 403 page'] = {
          value: req.body.default403Page,
          required: false,
          type: 'text',
        };
        validateObject['Email agent'] = {
          value: req.body.emailAgent,
          required: true,
          type: 'radio',
          options: ['mandrill', 'mail_server']
        };
        validateObject['Mandrill API Key'] = {
          value: req.body.mandrillApiKey,
          required: false,
          type: 'text'
        };
        validateObject['Password for email server'] = {
          value: req.body.siteEmailPassword,
          required: false,
          type: 'password',
          confirmation: true
        };
        validateObject['Email server address'] = {
          value: req.body.siteEmailHost,
          required: false,
          type: 'text',
        };
        validateObject['Email server port'] = {
          value: parseInt(req.body.siteEmailPort),
          required: false,
          type: 'number',
          min: 0,
        };
        validateObject['Use SSL?'] = {
          value: req.body.siteEmailSSL,
          required: true,
          type: 'select',
          options: ['0', '1'],
        };
        validateObject['Use TLS?'] = {
          value: req.body.siteEmailTLS,
          required: true,
          type: 'select',
          options: ['0', '1'],
        };
        validateObject['Email response timeout'] = {
          value: parseInt(req.body.siteEmailTimeout),
          required: false,
          type: 'number',
          min: 0,
        };
        validateObject['Google analytics id'] = {
          value: req.body.googleAnalyticsId,
          required: false,
          type: 'text',
        };
        validateObject['Backup frequency'] = {
          value: req.body.backupFreq,
          required: true,
          type: 'select',
          options: ['0', '1', '3', '6', '12', '24', '168'],
        };
        validateObject['Backup destination type'] = {
          value: req.body.backupDestinationType,
          required: true,
          type: 'select',
          options: ['email', 'file'],
        };
        validateObject['Backup destination'] = {
          value: req.body.backupDestination,
          required: false,
          type: 'text',
        };
        break;
      case 'configAccount':
        validateObject['Anonymous users'] = {
          value: req.body.anonUser,
          required: true,
          type: 'text',
        };
        validateObject['Deleted users'] = {
          value: req.body.deletedUser,
          required: true,
          type: 'text',
        };
        validateObject['Who can register accounts'] = {
          value: req.body.registerAuthority,
          required: true,
          type: 'radio',
          options: ['administrator', 'visitor', 'requireadmin'],
        };
        validateObject['Email verification required?'] = {
          value: req.body.emailVerify,
          required: false,
          type: 'checkbox',
        };
        validateObject['Send welcome message when accounts are activated'] = {
          value: req.body.account_activation_checkbox,
          required: true,
          type: 'checkbox',
        };
        validateObject['Send message when accounts are blocked'] = {
          value: req.body.account_blocked_checkbox,
          required: true,
          type: 'checkbox',
        };
        validateObject['Send message when accounts are cancelled'] = {
          value: req.body.account_cancelled_checkbox,
          required: true,
          type: 'checkbox',
        };
        break;
      case 'configTheme':
        validateObject['HTML head'] = {
          value: req.body.head,
          required: true,
          type: 'text',
        };
        validateObject['Page header'] = {
          value: req.body.section_header,
          required: true,
          type: 'text',
        };
        validateObject['Messages'] = {
          value: req.body.section_messages,
          required: true,
          type: 'text',
        };
        validateObject['Page footer'] = {
          value: req.body.section_footer,
          required: true,
          type: 'text',
        };
        validateObject['Bottom scripts'] = {
          value: req.body.section_bottomscripts,
          required: true,
          type: 'text',
        };
        validateObject['Extras'] = {
          value: req.body.section_extras,
          required: false,
          type: 'text',
        };
        break;
      case 'robotsForm':
        validateObject['robots.txt'] = {
          value: req.body.robotsTxt,
          required: true,
          type: 'text',
        };
        break;
      case 'userProfile':
        validateObject['User name'] = {
          value: req.body.userName,
          required: true,
          type: 'text',
        };
        validateObject['User email'] = {
          value: req.body.userEmail,
          required: true,
          type: 'email',
        };
        break;
      case 'roleCreate':
        validateObject['New role'] = {
          value: req.body.newRoleName,
          required: true,
          type: 'text'
        };
        break;
      case 'createContent':
        // this is a bit of a special case as there are several different types of content creation forms
        // so the first task is finding out which type of content is being created
        var contentType = req.params.type;
        switch(contentType.toLowerCase()){
          case 'category':
            validateObject['New category'] = {
              value: req.body.newCategoryName,
              required: true,
              type: 'text'
            };
            validateObject['Parent category'] = {
              value: req.body.parentcategory === 'nocategoryselected' ? 0 : parseInt(req.body.parentcategory),
              required: true,
              type: 'number'
            };
            break;
          case 'story':
            validateObject['Title'] = {
              value: req.body.title,
              required: true,
              type: 'text'
            };
            validateObject['Body'] = {
              value: req.body.body,
              required: true,
              type: 'text'
            };
            validateObject['Url'] = {
              value: req.protocol + '://' + req.hostname + '/' + req.body.url,
              required: false,
              type: 'url'
            };
            validateObject['Category'] = {
              value: req.body.category === 'nocategoryselected' ? 0 : parseInt(req.body.category),
              required: true,
              type: 'number'
            };
            break;
          case 'comment':
            validateObject['Title'] = {
              value: req.body.title,
              required: false,
              type: 'text'
            };
            validateObject['Body'] = {
              value: req.body.body,
              required: true,
              type: 'text'
            };
            validateObject['Url'] = {
              value: req.protocol + '://' + req.hostname + '/' + req.body.url,
              required: false,
              type: 'url'
            };
            break;
          default:
            validateObject['Content creation'] = {};
            break;
        }
        
        break;
      case 'contactForm':
        validateObject['Name'] = {
          value: req.body.contact_name,
          required: false,
          type: 'text'
        };
        validateObject['Email'] = {
          value: req.body.contact_email,
          required: true,
          type: 'email'
        };
        validateObject['Message'] = {
          value: req.body.contact_message,
          required: true,
          type: 'text'
        };
        break;
      default:
        formType(req, res, next);  // form validation can be extended by passing a new validation function instead of a form type
        break;
    };

    var validateResult = {};
    _.each(validateObject, function(value, key){
      validateResult[key] = _validateRules(value);
    });

    var validated = true;  // start by assuming all the form inputs validate
    _.each(validateResult, function(indResult, elem){
      if(indResult.result === 'fail'){
        validated = false;  // overall form validation fails if any element validation fails
        if(indResult.msg){systemMessage.set(req, 'danger', elem + ': ' + indResult.msg);} // send message to user
      };
    });
    if(!validated){
      if(formType === 'testValidation'){ return 'fail';} // UNIT TEST CODE: return fail
      redirectBack(0, req, res);  // if validation fails, send user back to current page
    } else {
      if(formType === 'testValidation'){ return 'success';} // UNIT TEST CODE: return success
      next();
    }
  };
}


/* 
 * function to apply validation rules
 *
 * @param {object} input - form input object including values and validation rules
 * @api private
 */
function _validateRules(input){
	// set defaults
	input.type = typeof input.type !== 'undefined' ? input.type : 'text';  // 'text' is default input type
	input.novalidate = typeof input.novalidate !== 'undefined' ? input.novalidate : false; // novalidate is set to false as default
	input.maxlength = typeof input.maxlength !== 'undefined' ? parseInt(input.maxlength) : Infinity; // maxlength is infinity as default
	input.max = typeof input.max !== 'undefined' ? parseInt(input.max) : Infinity; // max is infinity as default
	input.min = typeof input.min !== 'undefined' ? parseInt(input.min) : Number.NEGATIVE_INFINITY; // min is negative infinity as default
	input.value = typeof input.value !== 'undefined' ? typeof input.value === 'string' ? input.value.trim() : input.value : ''; // trim value (if value is a string) or set to empty string as default
	
	var response = {};

	// stop processing if novalidate flag is set
	if (input.novalidate){
		response.result = 'success';
		return response;
	}

	// stop processing if required flag is set and there is no value (except for checkboxes, which have no value when left unchecked)
	if(input.required){
		if((input.value === '' || input.value === undefined) && input.type !== 'checkbox'){ 
			response = {result: 'fail', msg: 'Please enter a value.'};
			return response;
		}
	}

	// check if input length exceeds maxlength
	if(input.type === 'text' || input.type === 'textfield' || input.type === 'email' || input.type === 'search' || input.type === 'password' || input.type === 'tel' || input.type === 'url'){
		if(input.value.length > input.maxlength){
			response = {result: 'fail', msg: 'Please enter less than ' + input.maxlength + ' characters.'};
			return response;
		}
	}
	
	switch (input.type){
		case 'text':
      // check if a value is not required and no value is provided, then stop the validation check
      if(input.value === '' && input.required === false){break;}
			
      break;
		case 'textfield':
      // check if a value is not required and no value is provided, then stop the validation check
      if(input.value === '' && input.required === false){break;}
			
      break;
		case 'email':
      // check if a value is not required and no value is provided, then stop the validation check
      if(input.value === '' && input.required === false){break;}
      
			// check if it is a valid email i.e. <something>@<something>.<something>
      if(!utility.validateEmailAddress(input.value)){
        response = {result: 'fail', msg: 'Please enter a valid email address.'};
        return response; 
      }
			//var emailRegexp = new RegExp("[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9-]+(\.[a-z0-9-]+)*"); // validates pattern *@*
			//if(!emailRegexp.test(input.value)){
			//	response = {result: 'fail', msg: 'Please enter a valid email address.'};
			//	return response;
			//}
			break;
		case 'url':
      // check if a value is not required and no value is provided, then stop the validation check
      if(input.value === '' && input.required === false){break;}
      
      // var urlRegexp = new RegExp("https?://.+"); // validates pattern http://* or https://*
			if(!utility.validateUrl(input.value)){
				response = {result: 'fail', msg: 'Please enter a valid URL.'};
				return response;
			}
			break;
		case 'number':
      // check if a value is not required and no value is provided, then stop the validation check
      if(input.value === '' && input.required === false){break;}
      
			// check if input.value is a number
      if(!_.isNumber(input.value)){
        response = {result: 'fail', msg: 'Please enter a number value'};
        return response;
      }
      
      // check if input.value falls between the minimum and maximum allowed values
      if(input.value > input.max){
				response = {result: 'fail', msg: 'Please enter a value less than or equal to ' + input.max + '.'};
				return response;
			}
			if(input.value < input.min){
				response = {result: 'fail', msg: 'Please enter a value more than or equal to ' + input.min + '.'};
				return response;
			}
			break;
	  case 'password':
      // check if a value is not required and no value is provided, then stop the validation check
      if(input.value === '' && input.required === false){break;}
      
      if(!input.confirmation){
				response = {result: 'fail', msg: 'Please ensure the password and confirmation are the same'};
				return response;
      }
	    break;
		case 'checkbox':
      // check if a value is not required and no value is provided, then stop the validation check
      if(input.value === '' && input.required === false){break;}
      
      // there is no real validation for a checkbox so always just pass
			break;
		case 'radio':
    case 'select':
      // check if a value is not required and no value is provided, then stop the validation check
      if(input.value === '' && input.required === false){break;}

      // check if input.value is equal to one of the options
      var flag = false;
      _.forEach(input.options, function(val, key){
        if(input.value === val){flag = true;}
      });
      if(!flag){
        response = {result: 'fail', msg: 'Please choose one of the given options'};
        return response;
      }
      break;
	}

	// if validation has not failed up to this point, then send success
	response.result = 'success';
	return response;
}