/*
 * General system functionality for handyjs
 */

'use strict';

const fs = require('fs')
  , path = require('path')
  , {exec} = require('child_process')
  , csrf = require('csurf')
  , _ = require('underscore')
  , bunyan = require('bunyan')
  , email = require('emailjs')
  , {google} = require('googleapis')
  , gmail = google.gmail('v1')
  , Base64 = require('js-base64').Base64
  , mysql = require('mysql')
  , utility = require(path.join(__dirname, 'utility'))
//  , user = require(path.join(__dirname, 'user'))  // user module require moved below BaseClass definition
  ;


/*
 * Base class definition for handyjs
 * Defines common structures and behaviors (e.g. saving, & loading from DB, etc)
 *
 * @api public
 */
class BaseClass {
  constructor(classDefinition, tableDefinition, runtimeDefinition=[]){
    // used to define object "this" values at class instantiation
    _.forEach(classDefinition, (val, key)=>{
      key !== 'tableDefinition' ? this[key] = val : null;  // assign all values, except for tableDefinition 
    })

    // used to define object database table
    const baseTableDefinition = {
      columns: [
        {name: "id", type: "BIGINT", autoincrement: true, primarykey: true},
        {name: 'createdate', type: 'DATETIME', notnull: true, default: 'CURRENT_TIMESTAMP'}, 
        {name: "modifydate", type: "DATETIME", notnull: true, default: "CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"}, 
        {name: 'deleted', type: 'BOOLEAN', default: false, datatype: 'boolean'},
      ]
    }

    // do not update table definition if one exists already
    // this is to enable dynamic modification of table definition
    this.tableDefinition = this.tableDefinition || tableDefinition;

    // used to add new object "this" values during runtime
    // array of objects with format {key: value}
    if(Array.isArray(runtimeDefinition) && runtimeDefinition.length){
      runtimeDefinition.forEach((definition)=>{
        _.forEach(definition, (val, key)=>{
          this[key] = val;
        })
      })
    }

    // add base table columns
    let uniqueFlag;
    baseTableDefinition.columns.forEach((column)=>{
      // start with the assumption that the new definitions provided do not overwrite the base definitions
      uniqueFlag = true;
      // check if the column name is unique
      this.tableDefinition.columns.forEach((tableColumn)=>{
        tableColumn.name === column.name ? uniqueFlag = false : null;
      })

      // add base column definition, if it has not been overwritten by a new definition
      uniqueFlag ? this.tableDefinition.columns.push(column) : null;
    })
  }

  // save object to database
  save(){
    return new Promise((resolve, reject)=>{
      const pool = systemGlobal.get('pool');
      pool.getConnection((err, connection)=>{
        if(err){return reject(err); }
        this.modifydate = new Date();
        this.createdate = this.createdate || new Date();
        
        let objectValue = {};
        let keyArray = [];  // will contain the list of all key columns
        this.tableDefinition.columns.forEach((column)=>{
          if (column.index || column.unique || column.primarykey){
            keyArray.push(column.name);
          }
          // ensure dates and time are saved as Date objects
          if(column.type === 'DATETIME' && typeof this[column.name] === 'string'){
            objectValue[column.name] = new Date(this[column.name])
          }

          // convert objects and arrays  (except Dates) into JSON strings 
          if(Array.isArray(this[column.name]) || _.isObject(this[column.name]) && !_.isDate(this[column.name])){
            objectValue[column.name] = JSON.stringify(this[column.name]);
          } else {
            objectValue[column.name] = this[column.name];
          }
        })

        let firstText = ''  // (column_name1, column_name2, etc)
        , secondText = ''   // (value1, value 2, value3, etc)
        , thirdText = '';   // (colum_name1 = value1, column_name2=value2, etc)

        const stringSeparator = ', ';
        _.forEach(objectValue, (val, key)=>{
          firstText += connection.escapeId(key) + stringSeparator;
          secondText += connection.escape(val) + stringSeparator;
          // add thirdText only if not a key column
          if(!keyArray.includes(key)){
            thirdText += connection.escapeId(key) + '=' + connection.escape(val) + stringSeparator;
          }
        })

        firstText = utility.removeTrailingCharacter(firstText, stringSeparator);
        secondText = utility.removeTrailingCharacter(secondText, stringSeparator);
        thirdText = utility.removeTrailingCharacter(thirdText, stringSeparator);

        let query = 'INSERT INTO ' + this.tableDefinition.name + ' (';
        query += firstText + ') ';
        query += 'VALUES (' + secondText + ') ';
        query += 'ON DUPLICATE KEY UPDATE ';
        query += thirdText;
        connection.query(query, (err, results)=>{
          connection.release();
          if(err){return reject(err); }
          this.id = !this.id ? this.id = results.insertId : this.id;  // update this.id if necessary
          return resolve();
        });
      });
    });
  }

  /* get object from database
   * optionally, specify identifier to use to locate object
   * instance invoking load should already have a set value for identifier or one of the default identifiers
   */
  load(identifier=[]){
    let defaultIdentifiers  = ['id', 'email'];  // default columns used to locate item in database
    let columnKeys;
    // if identifier is an array then do nothing.  if a string, place into an array, otherwise set to empty array
    identifier = Array.isArray(identifier) ? identifier : typeof identifier === 'string' ? [identifier] : [];

    columnKeys = identifier.concat(defaultIdentifiers);

    return _chooseIdentifier.bind(this)(columnKeys)
    .then(_loadObject.bind(this))
    .then(_applyTransforms.bind(this))
    .catch((err)=> Promise.reject(err))
  }

  /*
   * return all records that match the provided identifier(s)
   * identifiers is in the format [{column_name: value}, {column_name: value}]
  */
  find(identifiers=[]){
    return new Promise((resolve, reject)=>{
      if(!identifiers.length){return reject(new Error('at least one identifier required'))}
      const pool = systemGlobal.get('pool');
      pool.getConnection((err, connection)=>{
        if(err){return reject(new Error('error forming new connection in find - ' + err.message))}
        let whereClauseArray = [];
        identifiers.forEach((identifier)=>{
          Object.keys(identifier).forEach((columnName)=>{
            whereClauseArray.push(connection.escapeId(columnName) + '=' + connection.escape(identifier[columnName]));
          })
        })

        const whereClause = whereClauseArray.join(' AND ');
        const query = 'SELECT * FROM ' + connection.escapeId(this.tableDefinition.name) + ' WHERE ' + whereClause;
        connection.query(query, (err, results)=>{
          connection.release();
          if(err){return reject(new Error('error finding records - ' + err.message))}
          return resolve(results);
        })
      })
    })
  }

  removeRecord(){
    // remove the record from the database (as opposed to marking it deleted)
    return new Promise((resolve, reject)=>{
      const pool = systemGlobal.get('pool');
      pool.getConnection((err, connection)=>{
        if(err){return reject(new Error('error forming new connection in removeRecord - ' + err.message));}
        const query = 'DELETE FROM ' + connection.escapeId(this.tableDefinition.name )+ ' WHERE ' + connection.escapeId('id') + '=' + connection.escape(this.id);
        connection.query(query, (err, results)=>{
          connection.release();
          if(err){return reject(new Error('error removing record - ' + err.message))}
          return resolve();
        })
      })
    })
  }
}


/* 
 * helper function for BaseObject.load
 * decide to choose column used to search database
 * @params {array} columnKeys - array of column names in order of priority used to search database
 */

function _chooseIdentifier(columnKeys){
  return new Promise((resolve, reject)=>{
    if(!Array.isArray(columnKeys) || !columnKeys.length){return reject(new Error('_chooseIdentifier - invalid column key')); }
    let keyFoundFlag = false;  // will be set to true when a proper key is found
    let key;

    // identify the first valid column within the provided list of identifiers
    columnKeys.forEach((columnKey)=>{
      if((this[columnKey] !== undefined && this[columnKey] !== null) && !keyFoundFlag){
        keyFoundFlag = true;
        key = columnKey;
      }
    })

    return !keyFoundFlag ? reject(new Error('_chooseIdentifier - column key does not have a value; keys: ' + columnKeys.join(', ') + '; id: ' + this.id)) : resolve(key);
  })
}

/*
 * helper function for BaseObject.load
 * query database for saved object
 * @params {string} columnKey - column identifier for object
 */
function _loadObject(columnKey){
  return new Promise((resolve, reject)=>{
    if(!columnKey){ return reject(new Error('_loadObject: no column key provided')); }
    const pool = systemGlobal.get('pool');
    pool.getConnection((err, connection)=>{
      if(err){return reject(new Error('_loadObject: error creating pool connection - ' + err.message)); }
      let query = 'SELECT * FROM ' + connection.escapeId(this.tableDefinition.name) + ' ';
      query += 'WHERE ' + connection.escapeId(columnKey) + '=' + connection.escape(this[columnKey]);
      connection.query(query, (err, results)=>{
        connection.release();
        if(err){return reject(new Error('_loadObject: error querying database - ' + err.message)); }
        if(!results.length){return reject(new Error('_loadObject: object not found' + '\ncolumnKey - ' + columnKey + '\nthis:\n' + JSON.stringify(this))); }
        _.forEach(results[0], (val, key)=>{
          this[key] = val;
        })

        return resolve();
      })
    })
  })
}

/*
 * apply transforms to convert values loaded from database into appropriate types
 * e.g. convert this.roles needs to be converted from a string to an array
 *
 */
function _applyTransforms(){
  return new Promise((resolve, reject)=>{
    this.tableDefinition.columns.forEach((column)=>{
      switch(column.datatype){
        case 'boolean':
          this[column.name] = this[column.name] ? true : false;
          break;
        case 'object':
        case 'array':
          this[column.name] = JSON.parse(this[column.name]);
          break;
        default:
      }
    })

    return resolve();
  })
}


exports.BaseClass = BaseClass;

// require user needs to be below BaseClass declaration because user module references BaseClass leading to
// a possible recurssive state where BaseClass is not defined by the time the user module is loaded
const user = require(path.join(__dirname, 'user'));  



/*
 * Middleware to initialize unauthenticated users
 *  - set user id to zero
 *  - set roles to empty array []
 *
 * @api public
 */
exports.initializeUnauthenticatedUsers = initializeUnauthenticatedUsers;

function initializeUnauthenticatedUsers(req, res, next){
  req.session.user = req.session.user || {};
  req.session.user.id = req.session.user.id || 0;
  req.session.user.roles = req.session.user.roles || [];
  next();
}


/*
 * Middleware to check if handyjs installation is complete.
 * All GET requests (other than public files) is redirected to installation page if not
 *
 * @api public
 */
exports.checkInstallation = checkInstallation;

function checkInstallation(app, req, res, next){
  // skip install checks for public files
  const requestPath = req.path;
  const re = /\/css|\/js|\/fonts|\/img|(favicon.ico)/;
  const publicPath = re.test(requestPath);

  if(publicPath || req.method !== 'GET'){
    return next();
  } 

  // skip rest of processing if installation status flag is set
  if(systemGlobal.get('installation_flag')){
    return next();
  }

  // by this point, all installation checks have failed, so prompt user to run installation
  const pageInfo = prepRender(req, res);  // sets all the variables used in rendering the view
  return res.render('install', {pageInfo})
}


/*
 * Function to set and get system messages to be displayed to users
 * 
 */

let systemMessage = {

  set: (alert, req, res, next)=>{
    const callType = next ? 'middleware' : 'function';  // check if this is a middleware call
    req.session = req.session || {};
    req.session.alerts = req.session.alerts || [];
    req.session.alerts.push(alert);
    return callType === 'middleware' ? next() : null;  // call next if middleware
  },

  get: (req, res, next)=>{
    const callType = next ? 'middleware' : 'function';  // check if this is a middleware call
    req.session.alerts = req.session.alerts || [];
    res.locals.alerts = res.locals.alerts || {};

    req.session.alerts.forEach(function(alert){
      if(Object.keys(res.locals.alerts).includes(alert.type)){
        res.locals.alerts[alert.type].text += "<br>" + alert.text;
      } else {
        res.locals.alerts[alert.type] = {text: alert.text};
      }
    })

    delete req.session.alerts;
    return callType === 'middleware' ? next() : null;  // call next if middleware
  }
}

exports.systemMessage = systemMessage;


/*
 * systemGlobal is a system wide shared object used to avoid having global variables
 * systemGlobal.config is stored as a string in the DB table 'config'
 * 
 * @api public
 */

let systemGlobal = {
  config: {},
  project_install_functions: [],

  set: (key, value)=>{
    const immutableKeys = ['get', 'set', 'updateConfig', 'getConfig'];
    if(immutableKeys.includes(key)){
      return Promise.reject(new Error('WARNING: not allowed to update property ' + key + ' of systemGlobal'));
    }

    systemGlobal[key] = value;
    return Promise.resolve();
  },

  get: (key)=>{
    if(typeof systemGlobal[key] === 'undefined'){
      systemGlobal.set(key, null);
    }
    return systemGlobal[key];
  },

  // update and save systemGlobal.config
  updateConfig: (config)=>{
    return new Promise((resolve, reject)=>{
      
      // update systemGlobal
      _.forEach(config, (val, key)=>{
        systemGlobal.config[key] = val;
      })

      const pool = systemGlobal.get('pool');

      if(!pool){
        return reject(new Error('systemGlobal.updateConfig: error getting db pool'));
      }

      pool.getConnection((err, connection)=>{
        if(err){ return reject(new Error('systemGlobal.updateConfig: error creating db pool connection - \n' + err.message)); }
        const currentConfig = JSON.stringify(systemGlobal.get('config'));
        let query = 'INSERT INTO config(id, config) ';
        query += 'VALUES(1, ' + connection.escape(currentConfig) + ') ';
        query += 'ON DUPLICATE KEY UPDATE config = ' + connection.escape(currentConfig);

        connection.query(query, (err)=>{
          connection.release();
          if(err){ return reject(new Error('systemGlobal.updateConfig: error updating config in db -\n' + err.message)); }
          return resolve();
        })
      })
    })
    .catch((err)=> Promise.reject(err))
  },

  // get config
  getConfig: (key)=>{
    const config = Object.assign({}, systemGlobal.config) || {};  // make (shallow) copy of systemGlobal.config or return {}
    if(!key){
      return config;  // return entire config if key is not specified
    }

    config[key] = config[key] || null;  // set value to null if not already exists
    return config[key];
  }


}

exports.systemGlobal = systemGlobal;



/*
 * Default data structure definitions 
 * e.g. user, queues, config, etc
 *
 * @api public
 */
exports.getDefaultDataStructures = getDefaultDataStructures;

function getDefaultDataStructures(){
  return new Promise((resolve, reject)=>{
    
    // basic site configuration settings
    class Config {
      constructor(){
        this.tableDefinition = {
          name: 'config',
          columns: [
            {name: 'id', type: 'BIGINT', notnull: true, autoincrement: true, primarykey: true},
            {name: 'config', type: 'LONGTEXT'},
          ]
        }
      }
    }

    // task queue
    class TaskQueues {
      constructor(){
        this.tableDefinition = {
          name: 'taskqueues',
          columns: [
            {name: "type", type: "VARCHAR(40)"}, 
            {name: "id", type: "BIGINT", notnull: true, autoincrement: true, primarykey: true},
            {name: "payload", type: "LONGTEXT"}, 
            {name: "lockstatus", type: "BOOLEAN", default: false}
          ]
        }
      }
    }

    // create instances of each class in order to access the tableDefinition
    const newConfig = new Config();
    const newTaskQueue = new TaskQueues();
    let newUser = new user.User({});

    return resolve([newConfig, newTaskQueue, newUser]);

  })
}


/*
 * Create Database Tables
 * 
 * @param {object} table - table definition
 *    format {name: table_name, columns: [column_definitions], foreignkeys: [foreignkey_definitions]}
 * @api public
 */
exports.createDatabaseTables = createDatabaseTables;

function createDatabaseTables(table){
  return new Promise((resolve, reject)=>{
    const pool = systemGlobal.get('pool');
    pool.getConnection((err, connection)=>{
      if(err){ return reject(new Error('createDatabaseTables: error creating connection - \n', err.message)); }

      // build query
      let query = "CREATE TABLE IF NOT EXISTS " + connection.escapeId(table.name) + " (";
      let primarykey
      , foreignkeys = []
      , indexes = []
      , uniqueKeys = []
      ;
      table.columns.forEach((column)=>{
        query += connection.escapeId(column.name) + " " + column.type;
        query += column.notnull ? " NOT NULL" : "";
        query += column.autoincrement ? " AUTO_INCREMENT" : "";
        query += typeof column.default !== "undefined" ? " DEFAULT " + column.default : "";
        query += ", "
        column.primarykey ? primarykey = column.name : null;
        column.index ? indexes.push({name: column.name, type: column.type}) : null;  // save name and types of indexes
        column.unique ? uniqueKeys.push(column.name) : null;  // save names of unique keys
      })

      if(typeof table.foreignkeys !== "undefined"){
        table.foreignkeys.forEach((foreignkey)=>{
          foreignkeys.push(foreignkey)
        })
      }

      query += typeof primarykey !== "undefined" ? "PRIMARY KEY (" + connection.escapeId(primarykey) + "), " : "";

      foreignkeys.forEach((foreignkey)=>{
        query += "FOREIGN KEY " + connection.escapeId(foreignkey.name) + "(" + connection.escapeId(foreignkey.column) + ")";
        query += " REFERENCES " + connection.escapeId(foreignkey.reference) + "(" + connection.escapeId(foreignkey.refcolumn) + ")";
        query += " ON UPDATE " + foreignkey.onupdate;
        query += " ON DELETE " + foreignkey.ondelete;
        query += ", ";
      })

      // add unique keys
      if(uniqueKeys.length){
        uniqueKeys.forEach((uniqueKey)=>{
          query += "UNIQUE KEY(" + connection.escapeId(uniqueKey) + "), "
        })
      }

      // add indexes
      if(indexes.length){
        indexes.forEach((index)=>{
          // extract size from index type eg "VARCHAR(100)"
          const re = new RegExp('\\d+', 'g');
          const size = Number.parseInt(index.type.match(re)[0], 10);
          let indexSize = '';  // default is not to state any index prefix
          if(!Number.isNaN(size)){
            if(size > 128){
              indexSize = `(128)`;  // set index prefix to 128 to avoid exceeding maximum allowable prefix length
            }
          }

          query += `INDEX ${index.name}_idx USING HASH (${index.name}${indexSize}), `;
/*
          query += "INDEX " + index + "_idx" + " USING HASH ";
          query += "(" + index + "), "
*/
        })

        // remove trailing ", "
        query = utility.removeTrailingCharacter(query, ", ");
      }

      // remove trailing ", ", if exists
      query = query.trim();
      query = utility.removeTrailingCharacter(query, ",");
      query += ")";

      connection.query(query, (err)=>{
        connection.release();
        if(err){ return reject(new Error('createDatabaseTables: error creating table - \n' + err.message)); }
        return resolve();
      })
    })
  })
}


/*
 * alter database tables
 *
 * @param {object} alterDefinitions - single object or array of objects containing the alterations to the database
 *    format {table: <table to be altered>, alter_type: <type of alteration>, name: <column name>, type: <data type>}
 * @api public
 */
exports.alterDatabaseTables = alterDatabaseTables;

function alterDatabaseTables(alterDefinitions=[]) {
  // convert alterDefinitions to an array if not already
  alterDefinitions = Array.isArray(alterDefinitions) ? alterDefinitions : [alterDefinitions];
  return new Promise((resolve, reject)=>{
    const pool = systemGlobal.get('pool');
    pool.getConnection((err, connection)=>{
      if(err){ return reject(new Error('alterDatabaseTables: error creating connection - \n', err.message)); }
      let promiseArray = [];
      
      alterDefinitions.forEach((definition)=>{
        promiseArray.push(
          new Promise((resolve1, reject1)=>{
            let query = 'ALTER TABLE ' + connection.escapeId(definition.table);
            switch(definition.alter_type){
              case 'add':
                query += ' ADD COLUMN ' + connection.escapeId(definition.name) + ' ' + definition.type;
                break;
            }

            connection.query(query, (err, results)=>{
              if(err){
                connection.release();
                return reject1(err);
              }
              return resolve1();
            })
          })
        )    
      })

      Promise.all(promiseArray)
      .then(()=> Promise.resolve(connection.release()))
      .then(resolve)
      .catch(reject)
    })
  })
}


/*
 * Add cron tasks
 * creates tasks to be executed according to a schedule
 * NOTE: cron is managed via 2 objects, cronRecords (saved to db as part of systemGlobal.config) and cronTasks
 * cronTasks has the format {task_name: {run: task_function}}
 *    task_function should be a function that takes arguments (app, req, res, callback)
 *    task_function should return callback(null, true), if cron task successfully ran, or callback(err, false), otherwise
 * cronRecords has the format {task_name:  {freq: task_frequency, lastrun: time_last_run_successfully}}
 * to ensure both objects are kept synchronized, use only system.addCronTasks and system.removeCronTasks to change these objects
 *
 * @param {array} taskArray - array of tasks to be added to cron
 *    task format {name: task_name, run: task_function, freq: task_run_frequency}
 * @api public
 */
exports.addCronTasks = addCronTasks;

function addCronTasks(taskArray){
  return new Promise((resolve, reject)=>{
    // ensure taskArray is a valid array
    if(!Array.isArray(taskArray) || !taskArray.length){
      return reject(new Error('system.addCronTasks: addCronTasks only accepts arrays as input'));
    }

    let cronTasks = systemGlobal.get('cronTasks') || {};
    let cronRecords = systemGlobal.getConfig('cronRecords') || {};

    let promiseArray = [];

    let promiseFactory = function(task){
      return new Promise((resolve1, reject1)=>{
        // update cronRecords
        cronRecords[task.name] = {
          freq: task.freq,
          lastrun:  !cronRecords[task.name] ? 0 : cronRecords[task.name].lastrun || 0
        }

        systemGlobal.updateConfig({cronRecords})
        .then(()=>{
          // update cronTasks
          cronTasks[task.name] = {
            run: task.run
          }

          systemGlobal.set('cronTasks', cronTasks);
          resolve1();
        })
        .catch((err)=> reject1(err));      
      })
    }

    taskArray.reduce((acc, task)=>{
      return acc.then(()=> promiseFactory(task))
    }, Promise.resolve())
    .then(resolve)
    .catch((err)=> reject(new Error('system.addCronTasks: error adding cron task - ' + err.message)))
  })
}


/*
 * Run cron tasks
 * 
 * @params {obj} app - express app object
 * @params {obj} req - express request object
 * @params {obj} res - express response object
 * @api public
 */
exports.runCron = runCron;

function runCron(app, req, res){
  // get cron records
  let cronRecords = systemGlobal.getConfig('cronRecords');
  const now = Date.now();
  let tasksDueNames = [];
  _.forEach(cronRecords, (schedule, taskName)=>{
    if(now - schedule.lastrun > schedule.freq * 1000){
      tasksDueNames.push(taskName);
    }
  })

  if(tasksDueNames.length){
    let cronTasks = systemGlobal.get('cronTasks');
    let cronSuccess = [];

    tasksDueNames.forEach((taskName)=>{
      // check the cronTasks are properly set to avoid crashing
      if(cronTasks[taskName] && cronTasks[taskName].run){
        // execute cron task and get result
        cronTasks[taskName].run(app, req, res, (err, result)=>{
          result ? cronSuccess.push(taskName) : null;
          cronSuccess.forEach((successTask)=>{
            cronRecords[successTask].lastrun = now;
          })
          systemGlobal.updateConfig({cronRecords});
        })
      }
    })    
  }
}


/*
 * set values for pageInfo object - used to render views
 *
 * @api public
 */
exports.prepRender = prepRender;

function prepRender(req, res){
  const pageInfo = {
    config: {},
    other: {}
  };
  setCDNHeaders(res);
  pageInfo.config = systemGlobal.getConfig();
  pageInfo.handy_module_versions = systemGlobal.get('handy_module_versions');
  pageInfo.handy_module_development_status = systemGlobal.get('handy_module_development_status');
  systemMessage.get(req, res);  // move alerts into res.locals and remove from req.session
  return pageInfo;

}


/*
 * Insert item into task queue
 *
 * @params {string} queueType - queue type
 * @params {boolean} queueLockStatus - queue lock status
 * @params {object} payload - payload for processing
 *
 * @api public
 */
exports.insertQueueItem = insertQueueItem;

function insertQueueItem(queueType, queueLockStatus, payload){
  return new Promise((resolve, reject)=>{
    const pool = systemGlobal.get('pool');
    pool.getConnection((err, connection)=>{
      if(err){return reject(new Error('insertQueueItem: error creating pool connection - \n' + err.message)); }
      let query = 'INSERT INTO taskqueues (type, lockstatus, payload) VALUES(';
      const tempArray = [
        connection.escape(queueType), 
        connection.escape(queueLockStatus), 
        connection.escape(JSON.stringify(payload))
      ];
      query += tempArray.join(',') + ')';
      connection.query(query, (err, results)=>{
        connection.release();
        if(err){return reject(new Error('insertQueueItem: error creating taskqueue entry -\n' + err.message)); }
        return resolve();
      })
    })
  })
}


/*
 * Get items from task queue
 *
 * @params {object} taskIdentifier - id or type
 * @params {bool} respectLocks - if true, only unlock queue items are returned
 * 
 * @api public
 */
exports.getQueueItems = getQueueItems;

function getQueueItems(taskIdentifier, respectLocks=true){
  return new Promise((resolve, reject)=>{
    const pool = systemGlobal.get('pool');
    pool.getConnection((err, connection)=>{
      if(err){return reject(new Error('getQueueItems: error creating pool connection - \n' + err.message )); }
      let query = 'SELECT * FROM taskqueues WHERE ';
      let tempArray = [];
      if(respectLocks){
        tempArray.push('lockstatus=false');
      }
      _.forEach(taskIdentifier, (val, key)=>{
        tempArray.push(connection.escapeId(key) + '=' + connection.escape(val));
      })
      query += tempArray.join(' AND ');
      connection.query(query, (err, results)=>{
        connection.release();
        if(err){return reject(new Error('getQueueItems: error creating pool connection - \n' + err.message )); }

        // lock queue items
        let promiseArray = [];
        results.forEach((item)=>{
          promiseArray.push(
            changeQueueItemLockStatus(item, true)
          )
        })

        Promise.all(promiseArray)
        .then(()=>{
          return resolve(results)
        })
        .catch(reject);
      })
    })
  })
}


/*
 * change queue item lock status
 *
 * @params {obj} item - queue item
 * @params {boolean} lockstatus - new lock status
 *
 * @api public
 */
exports.changeQueueItemLockStatus = changeQueueItemLockStatus;

function changeQueueItemLockStatus(item, lockstatus){
  return new Promise((resolve, reject)=>{
    const pool = systemGlobal.get('pool');
    pool.getConnection((err, connection)=>{
      if(err){return reject(new Error('changeQueueLockStatus: error creating pool connection -\n' + err.message)); }
      let query = 'UPDATE taskqueues SET ';
      query += 'lockstatus= ' + connection.escape(lockstatus) + ' ';
      query += 'WHERE id=' + connection.escape(item.id);
      connection.query(query, (err)=>{
        connection.release();
        if(err){return reject(new Error('changeQueueLockStatus: error updating queue item -\n' + err.message)); }
        return resolve();
      })
    })
  })
}


/*
 * remove item from task queue
 *
 * @params {obj} item - queue item
 *
 * @api public
 */
exports.removeQueueItem = removeQueueItem;

function removeQueueItem(item){
  return new Promise((resolve, reject)=>{
    const pool = systemGlobal.get('pool');
    pool.getConnection((err, connection)=>{
      if(err){return reject(new Error('removeQueueItem: error creating pool connection -\n' + err.message)); }
      let query = 'DELETE FROM taskqueues WHERE ';
      query += 'id=' + connection.escape(item.id);
      connection.query(query, (err)=>{
        connection.release();
        if(err){return reject(new Error('removeQueueItem: error removing queue item -\n' + err.message)); }
        return resolve();
      })
    })
  })
}


/*
 * send emails using mail server or mail service
 * 
 * @params {string} from - email sender (defaults to siteEmail)
 * @params {string || array} to - email recipients
 * @params {string || array} cc - email cc
 * @params {string || array} bcc - email bcc
 * @params {string} subject - email subject
 * @params {string} text - email body
 * @params {array} attachment - email attachments
 *       format of each attachment object can be one of the following
 *       {data: 'string of data to attach'}
 *       {path: '/path/to/file/'}
 *       {stream: binary stream (in paused state) that will provide attachment data}
 *       other fields that can be included
 *       type: mime type of file
 *       name: name of file as seen by recipient
 *       inline: true/false boolean to attach file inline or not
 *       headers: object containing header=>value pairs for inclusion in this attachment's header
 * @params {int} userId - user id of sending user (used to identify user credentials)
 * @api public
 */
exports.sendEmail = sendEmail;

function sendEmail({from, to, cc, bcc, subject, text, attachment=[], userId}){
  return new Promise((resolve, reject)=>{
    switch(systemGlobal.getConfig('emailAgent')){
      case 'mail_server':
        const siteEmailPort = systemGlobal.getConfig('siteEmailPort')
        , siteEmailTLS = systemGlobal.getConfig('siteEmailTLS')
        , siteEmailSSL = systemGlobal.getConfig('siteEmailSSL')
        ;
        const serverOptions = {
          user: systemGlobal.getConfig('siteEmailUsername'),
          password: systemGlobal.getConfig('siteEmailPassword'),
          host: systemGlobal.getConfig('siteEmailHost'),
          tls: siteEmailTLS,
          ssl: siteEmailSSL,
          timeout: systemGlobal.getConfig('siteEmailTimeout') ? systemGlobal.getConfig('siteEmailTimeout') : 6000,
          port: siteEmailPort ? siteEmailPort : siteEmailTLS ? 587 : siteEmailSSL ? 465 : 25
        }

        const server = email.server.connect(serverOptions);

        let message = {text, subject};
        to = Array.isArray(to) ? to.join() : to; // convert array to string, if needed
        cc = Array.isArray(cc) ? cc.join() : cc; // convert array to string, if needed
        bcc = Array.isArray(bcc) ? bcc.join() : bcc; // convert array to string, if needed

        message.to = to;
        message.from = from;
        message.cc = cc;
        message.bcc = bcc;

        // process attachments

        // ensure attachements are sent as array
        if(!Array.isArray(attachment)){
          const msg = 'sendEmail: attachment must be an array';
          log({level: 'error', category: 'system', msg});
          return reject(new Error(msg));
        }

        const requiredFields = ['path', 'data', 'stream']; // at least one of these fields is required
        attachment.forEach((attach)=>{
          let requiredFieldsFlag = false;
          requiredFields.forEach((requiredField)=>{
            if(Object.keys(attach).includes(requiredField)){
              requiredFieldsFlag = true;
            }
          })

          if(!requiredFieldsFlag){
            const msg = 'sendEmail: one or more attachments is missing a required field - ' + attachments.toString();
            log({level: 'error', category: 'system', msg});
            return reject(new Error(msg));
          }
        })

        message.attachment = attachment;


        // check required message fields
        const requiredMessageFields = ['to', 'from', 'subject', 'text'];

        requiredMessageFields.forEach((requiredField)=>{
          if(message[requiredField] === undefined){
            const msg = 'sendEmail: message requires ' + requiredField + ' to be provided';
            log({level: 'error', category: 'system', msg});
            return reject(new Error(msg));
          }
        })

        if(process.env.NODE_ENV !== 'production'){
          return resolve();  // skip actual email send if environment is not production
        }

        server.send(message, (err)=>{
          if(err){
            const msg = 'sendEmail: error sending mail - \n' + err.message;
            log({level: 'error', category: 'system', msg});  
            return reject(new Error(msg));
          }
          return resolve();
        })


        break;
      case 'gmail':
        // get google auth token
        return new Promise((resolve1, reject1)=>{
          if(userId){
            let sendUser = new user.User({id: userId});
            sendUser.load(['id'])
            .then(()=>resolve1(sendUser))
            .catch(reject1)
          } else {
            return resolve1(null);
          }
        })
        .then((_this)=>{
          return new Promise((resolve1, reject1)=>{
            user.refreshGoogleAuthTokens.bind(_this)()
            .then((tokens)=>{
              const oauth2Client = user.generateGoogleOauth2Client();
              if(!oauth2Client){ return reject1(new Error('google oauth credentials missing')); }
              oauth2Client.setCredentials(tokens);

              to = Array.isArray(to) ? to.join() : to; // convert array to string, if needed
              cc = Array.isArray(cc) ? cc.join() : cc; // convert array to string, if needed
              bcc = Array.isArray(bcc) ? bcc.join() : bcc; // convert array to string, if needed

              let email = [];
              email.push('To: ' + to);
              cc ? email.push('Cc: ' + cc) : null;
              bcc ? email.push('Bcc: ' + bcc) : null;
              email.push('Subject: ' + subject);
              email.push('Content-type: text/html;charset=UTF-8');
              email.push('MIME-Version: 1.0');
              email.push('');
              email.push(text)
              email = email.join('\r\n').trim();
              email = Base64.encodeURI(email);

              gmail.users.messages.send({
                'userId': 'me',
                'auth': oauth2Client,
                'resource': {
                  'raw': email
                }
              }, function(err, response){
                  if(err){return reject1(err); }  // stop processing if there is an error
                  return resolve1();
              })
            })
            .catch(reject1);
          })
        })
        .then(()=>resolve())
        .catch((err)=>{
          const msg = 'sendEmail gmail: error sending mail - \n' + err.toString();
          log({level: 'error', category: 'system', msg});
          return reject(err);
        })
        break;
      case 'mandrill':
      default:
        const msg = 'sendEmail: email agent ' + systemGlobal.getConfig('emailAgent') + ' not yet implemented';
        log({level: 'error', category: 'system', msg}); 
        return reject(new Error(msg));
    }
  })
}


/*
 * put email in task queue
 * 
 * @params {string} from - email sender (defaults to siteEmail)
 * @params {string || array} to - email recipients
 * @params {string || array} cc - email cc
 * @params {string || array} bcc - email bcc
 * @params {string} subject - email subject
 * @params {string} text - email body
 * @params {array} attachment - email attachments
 *       format of each attachment object can be one of the following
 *       {data: 'string of data to attach'}
 *       {path: '/path/to/file/'}
 *       {stream: binary stream (in paused state) that will provide attachment data}
 *       other fields that can be included
 *       type: mime type of file
 *       name: name of file as seen by recipient
 *       inline: true/false boolean to attach file inline or not
 *       headers: object containing header=>value pairs for inclusion in this attachment's header
 * @params {int} sendDelay - delay in milliseconds before sending the email
 * @params {int} userId - user id of sender (if not provided, assumes system)
 * @api public
 */
exports.createEmailQueueItem = createEmailQueueItem;

function createEmailQueueItem({from, to, cc, bcc, subject, text, attachment=[], sendDelay=0, userId}){
  return new Promise((resolve, reject)=>{
    const queueType = 'mail'
    , queueLockStatus = false
    ;

    let message = {text, subject};
    to = Array.isArray(to) ? to.join() : to; // convert array to string, if needed
    cc = Array.isArray(cc) ? cc.join() : cc; // convert array to string, if needed
    bcc = Array.isArray(bcc) ? bcc.join() : bcc; // convert array to string, if needed

    message.to = to;
    message.from = from;
    message.cc = cc;
    message.bcc = bcc;

    // process attachments

    // ensure attachements are sent as array
    if(!Array.isArray(attachment)){
      return reject(new Error('createEmailQueueItem: attachment must be an array'));
    }

    const requiredFields = ['path', 'data', 'stream']; // at least one of these fields is required
    attachment.forEach((attach)=>{
      let requiredFieldsFlag = false;
      requiredFields.forEach((requiredField)=>{
        if(Object.keys(attach).includes(requiredField)){
          requiredFieldsFlag = true;
        }
      })

      if(!requiredFieldsFlag){
        return reject(new Error('createEmailQueueItem: one or more attachments is missing a required field - ', attachments.toString()));
      }
    })

    message.attachment = attachment;

    if(userId){
      if(Number.isNaN(Number.parseInt(userId, 10))){return reject(new Error('createEmailQueueItem: userId needs to be a number'))}
      message.userId = Number.parseInt(userId, 10);
    }

    // check required message fields
    let requiredMessageFields;
    switch(systemGlobal.getConfig('emailAgent')){
      case 'gmail':
        requiredMessageFields = ['to', 'subject', 'text'];
        break;
      default:
        requiredMessageFields = ['to', 'from', 'subject', 'text'];
    }
    
    let missingRequiredField = '';
    requiredMessageFields.forEach((requiredField)=>{
      if(message[requiredField] === undefined){
        missingRequiredField = requiredField;
      }
    });

    if(missingRequiredField){
      return reject(new Error('createEmailQueueItem: message requires ' + missingRequiredField + ' to be provided'));
    }

    const payload = {
      timestamp: Date.now(),
      sendDelay,
      message
    }

    insertQueueItem(queueType, queueLockStatus, payload)
    .then(resolve)
    .catch(reject)
  })
}


/*
 * process mail queue items
 * mail items are identified by task type 'mail'
 * since this function is usually invoked under cron, it returns result of true if successful or false, otherwise
 *
 * @params {obj} app - express app object
 * @params {obj} req - express request object
 * @params {obj} res - express response object
 * @params {function} callback - callback to be invoked with arguments (err, result)
 *
 * @api public
 */
exports.processMailQueue = processMailQueue;

function processMailQueue(app, req, res, callback){

  getQueueItems({type: 'mail'})
  .then((items)=>{
    return new Promise((resolve, reject)=>{
      const emailAgent = systemGlobal.getConfig('emailAgent');

      switch(emailAgent){
        case 'gmail':
          // handle gmail differently in order to apply rate limiting
          let delay = systemGlobal.getConfig('gmailSendBuffer');
          delay = Number.isNaN(Number.parseInt(delay, 10)) ? 0 : Number.parseInt(delay, 10);
          delay = delay * 1000;

          let promiseChain = Promise.resolve();
          items.forEach((item)=>{
            promiseChain = promiseChain.then(()=>delayPromise(delay)).then(()=>promiseFactory(item));
          })

          promiseChain
          .then(resolve)
          .catch(reject);

          function promiseFactory(item){
            return _processQueueItem(item, app, req, res)
            .then(()=> removeQueueItem(item))
            .catch((err)=> changeQueueItemLockStatus(item, false))  // unlock queue item
            ;
          }

          function delayPromise(delay){
            return new Promise((resolve1, reject1)=>{
              setTimeout(()=>{
                return resolve1();
              }, delay);
            })
          }

          break;
        default:
          let promiseArray = [];
          items.forEach((item)=>{
            promiseArray.push(
              _processQueueItem(item, app, req, res)
              .then(()=> removeQueueItem(item))
              .catch(err=> changeQueueItemLockStatus(item, false))  // unlock queue item
            )
          })

          Promise.all(promiseArray)
          .then(resolve)
          .catch(reject)

      }
    })
  })
  .then(()=> callback(null, true))
  .catch((err)=> callback(err, false))
}

// helper function for processMailQueue
function _processQueueItem(item, app, req, res){
  return new Promise((resolve, reject)=>{
    const payload = JSON.parse(item.payload);
    const {message, sendDelay, timestamp} = payload;
    
    // check if sendDelay has expired
    const now = Date.now();
    if(now - timestamp < sendDelay){
      return reject(new Error('email send delay has not yet elapsed'))
    }

    sendEmail(message)
    .then(resolve)
    .catch(reject)
  })
}


/*
 * create cron path
 * creates random string which is used as the path to run cron e.g. /cron/random_string
 * adds a level of security through obscurity to the app
 * 
 * @api public
 */
exports.createCronKey = createCronKey;

function createCronKey(){
  const cronKey = utility.generateRandomString(30);
  return systemGlobal.updateConfig({cronKey});
}


/*
 * logger class constructor
 * enables initialization, recording and reporting of logs
 *
 */

class Logger {
  constructor(name){
    this.name = name;
    this.logFileDefaultDestination = systemGlobal.getConfig('logFileDefaultDestination') || path.join(__dirname, '..', '..', '..', '..', 'logs', this.name + '.log');
    this.path = systemGlobal.getConfig('logDestination') || this.logFileDefaultDestination;
  }

  initialize(){
    let log = bunyan.createLogger({
      name: this.name,
      serializers: {
        err: bunyan.stdSerializers.err,
        req: _reqSerializer,
      },
      streams: [{
        type: 'rotating-file',
        path: this.path,
        period: '1w',
        count: 3
      }]
    })

    // save default log destination
    return systemGlobal.updateConfig({logFileDefaultDestination: this.logFileDefaultDestination})
    .then(()=>{
      return new Promise((resolve, reject)=>{
        systemGlobal.set('Log', log);
        return resolve();
      })
    })
    .catch((err)=> Promise.reject(err));
  }
}

exports.Logger = Logger;

/*
 * serializer function for express request object
 * replaces standard serializer provided by bunyan because
 * bunyan uses req.url rather than req.originalUrl
 */ 
function _reqSerializer(request){
  const requiredFields = ['method', 'originalUrl', 'headers'];  // fields to be extracted
  
  // check all necessary objects and fields are present to avoid throwing errors
  if(!request){
    return request;
  }

  requiredFields.forEach((field)=>{
    if(!request[field]){
      return request;
    }
  })

  return {
    method: request.method,
    url: request.originalUrl,
    headers: request.headers
  };
}

/*
 * create log record
 *
 * @params {object} record
 *         format {level: 'log event level', category: log event category,  
 *                 msg: log message, req: express request object, ....  }
 *
 * @api public
 */
exports.log = log;

function log(record){
  const {level='info', req={}, msg='', category='system'} = record;
  const notIncludedInLogRecord = ['level', 'msg'];  // added differently than the rest of the log records

  // filter out keys that should not be included in the log
  let logRecord = {}; 
  Object.keys(record).forEach((key)=>{
    if(!notIncludedInLogRecord.includes(key)){
      logRecord[key] = record[key]
    }
  })

  const log = systemGlobal.get('Log');
  
  // exit gracefully if log is not properly initialized
  if(!log || typeof log.info !== 'function' || typeof log.warn !== 'function' || typeof log.error !== 'function'){
    return;
  }

  switch(level){
    case 'warn':
      log.warn(logRecord, msg)
      break;
    case 'error':
      log.error(logRecord, msg)
      break;
    case 'info':
    default:
      // default is 'info'
      log.info(logRecord, msg)
      break;
  }

  return;
}


/*
 * add new log view definition
 * enables customization of log view by adding new selectors to the view
 *
 * @params {object} definition - log view definition 
 *        format {id: <text used for selector eg. 'url', 
 *                definition: 'log object parameters for the value of the log e.g. req.url'}
 *
 * @api public
 */
exports.addLogViewDefinition = addLogViewDefinition;

function addLogViewDefinition(definition){
  return new Promise((resolve, reject)=>{
    // verify format
    if(typeof definition.id !== 'string' || typeof definition.definition !== 'string'){
      return reject(new Error('addLogViewDefinition: invalid log view definition - id must be a string: '));
    }

    let currentLogViewDefinitions = systemGlobal.getConfig('logViewDefinitions');
    // check if new definition already exists, if so, skip addition
    let definitionAlreadyExists = false;  // assume new definition
    currentLogViewDefinitions.forEach((currentDefinition)=>{
      currentDefinition.id === definition.id ? definitionAlreadyExists = true : null;
    })

    if(!definitionAlreadyExists){
      currentLogViewDefinitions.push(definition);
      systemGlobal.updateConfig({'logViewDefinitions': currentLogViewDefinitions})
      .then(resolve)
      .catch(reject)      
    } else {
      return resolve();
    }
  })
}


/* 
 * Add event triggers
 * creates triggers set off by events which in turn set off new actions
 * NOTE: it is possible to create a never ending loop of events and triggers so use with care
 * NOTE: creating a trigger with the same name as an existing trigger will overwrite it
 *
 * @param {array} triggerArray - array of triggers to be created
 *  triggers have format {name: 'unique trigger name', actions: [array of actions]}
 * @api public
 */
exports.addTriggers = addTriggers;

function addTriggers(triggerArray){
  return new Promise((resolve, reject)=>{
    // ensure triggerArray is a valid array
    if(!Array.isArray(triggerArray) || !triggerArray.length){
      return reject(new Error('system.addTrigger: addTrigger only accepts arrays as input'));
    }

    let triggers = systemGlobal.get('triggers') || {};
    triggerArray.forEach((newTrigger)=>{
      triggers[newTrigger.name] = newTrigger.actions;
    })

    systemGlobal.set('triggers', triggers);
    return resolve();
  });
}



/*
 * Remove event triggers
 *
 * @param {array | object} triggerArray - array of triggers to be removed.  also accepts single trigger object
 * @api public
 */
exports.removeTriggers = removeTriggers;

function removeTriggers(triggerArray){
  return new Promise((resolve, reject)=>{
    let parameterType = 'array';  // default assumption is argument is in array form

    // check if triggerArray is a valid array
    if(!Array.isArray(triggerArray) || !triggerArray.length){
      // if not an array, then check if it is a single trigger object
      if(typeof triggerArray !== 'object' || !triggerArray.name || !Array.isArray(triggerArray.actions)){
        return reject(new Error('system.removeTrigger: removeTrigger only accepts arrays or single trigger objects as input'));
      } else {
        parameterType = 'object';
      }
    }

    let triggers = systemGlobal.get('triggers') || {};

    switch(parameterType){
      case 'array':
        triggerArray.forEach((removeTrigger)=>{
          delete triggers[removeTrigger.name];
        })
        break;
      case 'object':
        delete triggers[triggerArray.name];
        break;
    }

    systemGlobal.set('triggers', triggers);
    return resolve();
  })
}


/*
 * add actions to trigger
 * NOTE: adding an action to a trigger where there is already an action with the same name 
 * will overwrite the existing action
 * @params {array} actions - actions to be added to triggers
 *     actions format {trigger: 'trigger name', name: 'action name', run: function_returning_promise}
 * @api public
 */
exports.addTriggerActions = addTriggerActions;

function addTriggerActions(actions){
  return new Promise((resolve, reject)=>{
    // check if actions is an array
    if(!Array.isArray(actions) || !actions.length){
      return reject(new Error('system.addTriggerActions: addTriggerActions only accepts arrays as arguments'));
    }

    let currentTriggers = systemGlobal.get('triggers') || {};
    actions.forEach((newAction)=>{
      let selectedTrigger = currentTriggers[newAction.trigger];
      // only add actions to existing triggers
      if(selectedTrigger){
        // check remove action with same name if already exists
        let selectedActions = selectedTrigger.actions || [];
        selectedActions.forEach((existingAction, key)=>{
          if(existingAction.name === newAction.name){
            delete selectedActions[key];
          }
        })

        selectedActions.push({name: newAction.name, run: newAction.run});
        currentTriggers[newAction.trigger].actions = selectedActions;
      }
    })

    systemGlobal.set('triggers', currentTriggers);
    return resolve();
  })
}


/*
 * remove trigger actions
 *
 * @params {array} actions - actions to be removed from specified triggers
 *     actions format {trigger: 'trigger name', name: 'action name'}
 * @api public
 */
exports.removeTriggerActions = removeTriggerActions;

function removeTriggerActions(actions){
  return new Promise((resolve, reject)=>{
    // check if actions is an array
    if(!Array.isArray(actions) || !actions.length){
      return reject(new Error('system.removeTriggerActions: removeTriggerActions only accepts arrays as arguments'));
    }

    let currentTriggers = systemGlobal.get('triggers') || {};

    actions.forEach((removeAction)=>{
      let selectedTrigger = currentTriggers[removeAction.trigger];
      if(selectedTrigger){
        let currentActions = selectedTrigger.actions || [];
        currentActions.forEach((currentAction, key)=>{
          if(currentAction.name === removeAction.name){
            delete currentActions[key];
          }
        })

        currentTriggers[removeAction.trigger].actions = currentActions;
      }
    })

    systemGlobal.set('triggers', currentTriggers);
    return resolve();
  })
}


/*
 * backup database
 * run under cron so should return callback(err, result) where result is true if successful
 *
 * @params {object} app - express app object
 * @params {object} req - express request object
 * @params {object} res - express response object
 * @params {function} callback - callback to be invoked with arguments (err, result)
 *
 * @api public
*/

exports.backupDatabase = backupDatabase

function backupDatabase(app, req, res, callback){
  // set backup file name format "backup_$sitename_$timestamp.sql"
  const now = new Date();
  const year = now.getFullYear();
  let month = now.getMonth() + 1;
  month = month < 10 ? '0' + month.toString() : month.toString();
  let day = now.getDate();
  day = day < 10 ? '0' + day.toString() : day.toString();
  let hour = now.getHours();
  hour = hour < 10 ? '0' + hour.toString() : hour.toString();
  let minute = now.getMinutes();
  minute = minute < 10 ? '0' + minute.toString() : minute.toString();
  let second = now.getSeconds();
  second = second < 10 ? '0' + second.toString() : second.toString();

  const re = /\s/g;
  const siteName = systemGlobal.getConfig('siteName').replace(re, '_');
  let backupFileName = 'backup_' + siteName;
  backupFileName += '_' + year + month + day + hour + minute + second + '.sql';
  const handyDirectory = systemGlobal.get('handyDirectory');
  const tmpBackupFilePath = path.join(handyDirectory, 'tmp');

  _dumpDatabase({backupFileName, tmpBackupFilePath, year, month, day, hour, minute, second})
  .then(_gzipBackupFile)
  .then(_transportBackupFile)
  .then(_deleteBackupFile)
  .then(()=> callback(null, true))
  .catch((err)=> callback(err, false))
}

// dump database to file
function _dumpDatabase({backupFileName, tmpBackupFilePath, year, month, day, hour, minute, second}){
  return new Promise((resolve, reject)=>{
    // prepare linux command to dump database
    const credentials = '-u ' + systemGlobal.get('databaseUser') + ' -p' + systemGlobal.get('databasePassword');
    const backupCommand = 'mysqldump ' + credentials + ' ' + systemGlobal.get('database') + ' > ' + path.join(tmpBackupFilePath, backupFileName);
    
    exec(backupCommand, (err, stdout, stderr)=>{
      if(err){return reject(err);}
      return resolve({backupFileName, tmpBackupFilePath, year, month, day, hour, minute, second})
    })
  })
}

// gzip database dump file
function _gzipBackupFile({backupFileName, tmpBackupFilePath, year, month, day, hour, minute, second}){
  return new Promise((resolve, reject)=>{
    const gzipCommand = 'gzip ' + path.join(tmpBackupFilePath, backupFileName);
    exec(gzipCommand, (err, stdout, stderr)=>{
      if(err){return reject(err);}
      backupFileName += '.gz';
      return resolve({backupFileName, tmpBackupFilePath, year, month, day, hour, minute, second});
    })
  })
}

// transport backup file (send to file drive or send by email)
function _transportBackupFile({backupFileName, tmpBackupFilePath, year, month, day, hour, minute, second}){
  return new Promise((resolve, reject)=>{
    switch(systemGlobal.getConfig('backupDestinationType')){
      case 'email':
        _mailBackupFile({backupFileName, tmpBackupFilePath, year, month, day, hour, minute, second})
        .then(()=> resolve({backupFileName, tmpBackupFilePath}))
        .catch(reject)
        break;
      case 'file':
        _moveBackupFile({backupFileName, tmpBackupFilePath})
        .then(()=> resolve({backupFileName, tmpBackupFilePath}))
        .catch(reject);
        break;
    }
  })
}


// send backup file by email
function _mailBackupFile({backupFileName, tmpBackupFilePath, year, month, day, hour, minute, second}){
  return new Promise((resolve, reject)=>{
    const to = systemGlobal.getConfig('backupDestination');
    const subject = '[' + systemGlobal.getConfig('siteName') + '] Backup - ' + backupFileName;
    const text = 'Database backup\n\nSite name: ' + systemGlobal.getConfig('siteName') + '\nBackup time: ' + month + '/' + day + '/' + year + ' - ' + hour + ':' + minute + ':' + second;
    const attachment = [{
          name: backupFileName,
          type: 'application/gzip',
          path: path.join(tmpBackupFilePath, backupFileName)
    }];

    createEmailQueueItem({to, subject, text, attachment})
    .then(()=> resolve({backupFileName, tmpBackupFilePath}))
    .catch(reject)
  })
}

// move backup file to final destination
function _moveBackupFile({backupFileName, tmpBackupFilePath}){
  return new Promise((resolve, reject)=>{
    const destination = path.join(systemGlobal.getConfig('backupDestination'), backupFileName);
    const source = path.join(tmpBackupFilePath, backupFileName);
    let read = fs.createReadStream(source);
    
    // need a debouncer to avoid the multiple resolve or reject calls
    // given that a read error will trigger a write error
    let debouncer =false;

    read.on('error', (err)=>{
      if(!debouncer){
        debouncer = true;
        return reject(err);
      }
    });

    let write = fs.createWriteStream(destination);
    write.on('error', (err)=>{
      if(!debouncer){
        debouncer = true;
        return reject(err);
      }
    });
    
    write.on('close', (ex)=>{
      if(!debouncer){
        return resolve()
      }
    });

    read.pipe(write);
  })
}


// delete original backup file
function _deleteBackupFile({backupFileName, tmpBackupFilePath}){
  return new Promise((resolve, reject)=>{
    let target = path.join(tmpBackupFilePath, backupFileName);
    fs.unlink(target, (err)=>{
      return err ? reject(err) : resolve();
    })
  })
}


/*
 * set backup cron task
 *
 * @api public
*/
exports.setBackupCronTask = setBackupCronTask;

function setBackupCronTask(){
  return new Promise((resolve, reject)=>{
    const {backupFreq}= systemGlobal.getConfig();
    const cronTask = {
      name: 'system database backup',
      run: backupDatabase,
      freq: backupFreq * 60 * 60 * 1000
    }

    addCronTasks([cronTask])
    .then(resolve)
    .catch(reject)
  })
}


/*
 * middleware to apply rate limiting to requests
 *
 * @params {string} requestType - request type e.g. 'login', etc
 * @params {int} rateLimit - minimum time, in seconds, between requests of the same type
 * @params {object} app - express app object
 * @params {object} req - express request object
 * @params {object} res - express response object
 * @params {function} next - express next function
 * @api public
*/
exports.throttle = throttle;

function throttle(requestType='general', rateLimit=10, app, req, res, next){
  const now = Date.now();

  // request tracking is stored in app object and not req.session as req.session
  // can be bypassed by avoiding setting cookies
  let requestTracker = app.get('requestTracker') || {};
  requestTracker[req.ip] = requestTracker[req.ip] || {};

  // prune expired request trackers
  let expiredTrackers = [];
  _.forEach(requestTracker[req.ip], (tracker, trackerType)=>{
    if(now > tracker.expiry){expiredTrackers.push(trackerType);}
  })

  expiredTrackers.forEach((expiredTracker)=>{
    delete requestTracker[req.ip][expiredTracker];
  })

  // if tracker for this request has not expired, then throw error
  if(Object.keys(requestTracker[req.ip]).includes(requestType)){
    let error = new Error('rate limit exceeded');
    error.code = 'RATELIMITEXCEEDED';
    return next(error)
  }

  // if no tracker found, then update expiry date
  requestTracker[req.ip][requestType] = requestTracker[req.ip][requestType] || {};
  requestTracker[req.ip][requestType].expiry = now + rateLimit * 1000;
  app.set('requestTracker', requestTracker);
  return next();
}

/*
 * set headers for compatibility with CDN usage
 * add instructions not to cache routes when CDN is in use
 * @params {object} res - express response object
 * @params {int} age - maximum caching time (in seconds)
 * @api public
*/
exports.setCDNHeaders = setCDNHeaders;

function setCDNHeaders(res, age=0, cacheType='private', storeType='no-store') {
  // check if CDN is in use
  const cdnInUse = process.env.CDN_STATUS || false;

  if(cdnInUse){
    res.set(`Cache-Control`, `${cacheType}, ${storeType}, max-age=${age}`);
  }
}


/*
 * create a temporary pool object 
 * used for tasks requiring high volumes of connections eg analytics
 * this avoids running up the number of open connections since this
 * pool is temporary and can be ended, unlike the main pool
 * 
 * @params {int} connectionLimit - maximum number of simultaneous connections
 * @api public
*/

exports.createTemporaryPool = createTemporaryPool;

function createTemporaryPool(connectionLimit=10) {
  return new Promise((resolve, reject)=>{
    const host = systemGlobal.get('databaseHost');
    const user = systemGlobal.get('databaseUser');
    const password = systemGlobal.get('databasePassword');
    const database = systemGlobal.get('database');

    // define database connection options
    const connectionOptions = {
      host: host,
      user: user,
      password: password,
      database: database,
      connectionLimit: connectionLimit,
      connectTimeout: 120000,
      acquireTimeout: 120000,
      charset: 'utf8mb4'
    };

    let pool = mysql.createPool(connectionOptions);
    resolve(pool);
  })
}


/*
 * destroy temporary pool
 * used to remove the temporary pool and close all connections
 * this ensures apps do not run up the number of open connections
 *
 * @params {object} pool - temporary pool to be closed
 * @api public
*/

exports.destroyTemporaryPool = destroyTemporaryPool;

function destroyTemporaryPool(pool) {
  return new Promise((resolve, reject)=>{
    pool.end((err)=>{
      if(err){return reject(new Error('error destroying temporary pool: ' + err.message))}
      return resolve();
    });
  })
}


/*
 * send network response stream in chuncks
 * 
 * @params {function} func - function that returns data on event 'data'; ends with event 'end' and generates 
 *                    errors with event 'error'
 * @params {string} delimiter - string that is sent to indicate distinct data chuncks ie data1-delimiter-data2-...
 *                       it should be a string that is unlikely to occur in the data chuncks and should
 *                       not include repeating patterns
 * @params {object} res - express response object
 *
 * @api public
*/
function sendStream(func, delimiter, res) {
  return new Promise((resolve, reject)=>{
    // check if delimiter is provided
    if(typeof delimiter !== 'string'){
      return reject(new Error('system.sendStream: delimiter string not provided'));
    }

    func.on('data', (data)=>{
      const sendData = JSON.stringify({data});
      res.write(sendData);
      res.write(delimiter);
    })

    func.on('end', ()=>{
      res.end();
      return resolve();
    })

    func.on('error', (err)=>{
      res.write(JSON.stringify({error: err.message}));
      res.end();
      return reject(new Error(`system.sendStream: ${err.message}`))
    })
  })
}

exports.sendStream = sendStream;