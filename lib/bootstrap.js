/*
 * Functionality required upon startup of Handyjs
 */

'use strict';

const fs = require('fs')
  , path = require('path')
  , os = require('os')
  , csrf = require('csurf')
  , mysql = require('mysql')
  , _ = require('underscore')
  , utility = require(path.join(__dirname, 'utility'))
  , system = require(path.join(__dirname, 'system'))
  , user = require(path.join(__dirname, 'user'))
  ;


/*
 * Create random strings used for secret keys, redis db prefix, etc
 *
 * @api public
 */

exports.secretStrings = secretStrings;

function secretStrings(app){
  const pathToFile = app.get('handy_secret_strings_file');
  
  return _readRandomizedStringFile(pathToFile)
  .catch((err)=>{
    return _createRandomizedStringFile(pathToFile)
  })
}

function _readRandomizedStringFile(pathToFile){
  return new Promise((resolve, reject)=>{
    
    fs.readFile(pathToFile, 'utf8', (err, data)=>{
      if(err){return reject(new Error('randomized strings file not found - ' + err.message)); }
      return resolve(JSON.parse(data));
    })
  })
}

function _createRandomizedStringFile(pathToFile){
  return new Promise((resolve, reject)=>{
    // create randomized strings
    
    // utilize the same secret between express-session and cookie-session to avoid conflicts
    const secret = utility.generateRandomString(20);  

    const secretStrings = {
      sessionSecret: secret,
      cookieSecret: secret,
      redisPrefix: utility.generateRandomString(5) + '_'
    }

    // save secretStrings to file
    fs.writeFile(pathToFile, JSON.stringify(secretStrings, null, 2), {encoding: 'utf8', mode: 384}, (err)=>{
      if(err){return reject(new Error('randomized strings file could not be saved - ' + err. message)); }
      return resolve(secretStrings);
    })
  })
}

/*
 * Run initialization sequence for starting and configuring handyjs
 * Connects to database, creates tables (if necessary) and reads
 * site configuration into memory
 *
 * @api public
 */
exports.initialize = initialize;

function initialize(app){
  // set location of config files
  //const handy_config_file = path.join(__dirname, '..', 'config', 'handy-config.json');
  //app.set('handy_config_file', handy_config_file);
  // set location of secret string file
  //const secret_strings_file = path.join(__dirname, '..', 'config', 'randomized-strings.json');
  //app.set('handy_secret_strings_file', secret_strings_file);
  return _initializeConfigDirectory(app)
  .then(() => system.systemGlobal.set('installation_flag', false)) // start with assumption that handyjs requires installation
  .then(_setDefaultConfiguration)                             // set default configs
  .then(_loadDatabaseConfigFromFile.bind(null, app))          // load db config from file
  .then(_createDatabasePool)                                  // create database pool
  .then(_loadGlobalConfigFromDatabase)                        // load global config from database
  .then(_startLogger)                                         // start logger
  .then(_initializeCronTasks)                                 // initialize cron tasks
  .then(_initializeTriggers)                                  // initialize triggers
  .then(()=>{
    return new Promise((resolve, reject)=>{
      // set installation flag
      system.systemGlobal.set('installation_flag', true);

      // flag to indicate module development mode ie. used to select location of module files
      system.systemGlobal.set('handy_module_development_status', app.get('handy_module_development_status'));
      return resolve();
    })
  })
  .catch((err)=>{
console.log('initialization error:\n', err);
    // initialize always needs to resolve since the http server cannot start otherwise
    return Promise.resolve();
  })
}

// create config directory and set config file names and paths
function _initializeConfigDirectory(app){
  return new Promise((resolve, reject)=>{
    const handy_config_directory_path = app.get('handy_config_directory_path') || path.join(__dirname, '..', '..', '..', '..', 'handy_config');
    app.set('handy_config_directory_path', handy_config_directory_path);

    // create config directory, if it does not already exist
    if(fs.existsSync(handy_config_directory_path)){
      // directory already exists, so set paths for config and secret strings files and return
      _setConfigAndSecretStringsFilePaths(app);
      return resolve();
    } else {

      fs.mkdir(handy_config_directory_path, (err)=>{
        if(err){return reject(new Error('_initializeConfigDirectory: error creating config directory - \n', err.message)); }

        // create .gitignore file
        const gitIgnore = {
          fileName: '.gitignore',
          content: '*' + os.EOL + '!.gitignore',
        }
        const pathToFile = path.join(app.get('handy_config_directory_path'), gitIgnore.fileName);
        fs.writeFile(pathToFile, gitIgnore.content, {encoding: 'utf8', mode: 384}, (err)=>{
          if(err){return reject(new Error('_initializeConfigDirectory: error creating .gitignore file - \n', err.message)); }
          
          // set paths for config and secret strings files
          _setConfigAndSecretStringsFilePaths(app);

          return resolve();
        })
      })
    }
  })
}


// helper function for _initalizeConfig Directory
function _setConfigAndSecretStringsFilePaths(app){
  const handy_config_directory_path = app.get('handy_config_directory_path')

  // set file path for handy config file
  const handy_config_file = path.join(handy_config_directory_path, 'handy-config.json');
  app.set('handy_config_file', handy_config_file);

  // set file path for randomized strings file
  const secret_strings_file = path.join(handy_config_directory_path, 'randomized-strings.json');
  app.set('handy_secret_strings_file', secret_strings_file);

  return;
}


// load flat file containing basic site and database configuration
function _loadDatabaseConfigFromFile(app){
  return new Promise((resolve, reject)=>{
    const configFile = app.get('handy_config_file');
    fs.readFile(configFile, 'utf8', (err, fd)=>{
      if(err){return reject(new Error ('_loadDatabaseConfigFromFile: error loading basic site config file -\n', err.message)); }
      const {dbHost, dbUser, dbPassword, dbName} = JSON.parse(fd);
      return resolve({dbHost, dbUser, dbPassword, dbName});
    })
  })
}

// create database pool
function _createDatabasePool(config){
  return new Promise((resolve, reject)=>{
    // define database connection options
    const connectionOptions = {
      host: config.dbHost,
      user: config.dbUser,
      password: config.dbPassword,
      database: config.dbName,
      connectionLimit: 50,
      connectTimeout: 120000,
      acquireTimeout: 120000,
      charset: 'utf8mb4'
    };


    let pool = mysql.createPool(connectionOptions);

    system.systemGlobal.set('pool', pool);
    system.systemGlobal.set('database', connectionOptions.database);
    system.systemGlobal.set('databaseUser', connectionOptions.user);
    system.systemGlobal.set('databasePassword', connectionOptions.password);
    system.systemGlobal.set('databaseHost', connectionOptions.host);
    resolve();
  })
}

// create default tables in database - parent app can create more tables as needed
function _createDefaultDatabaseTables(){
  // identify default data structures e.g. config, queues, users, etc
  // identify default content structures e.g. category, stories, comment
  let dataStructures = [];
  return system.getDefaultDataStructures()
  .then((defaultDataStructures)=>{
    dataStructures = dataStructures.concat(defaultDataStructures);
    return Promise.resolve()
  })
  //.then(content.getDefaultContentStructures)  // to be implemented
  .then(()=>{
    /*
     * create database tables for each structure in sequence in order to ensure
     * foreign key reference targets exist at the time of creation
     */
    let promiseChain = Promise.resolve();
    dataStructures.forEach((dataStructure)=>{
      promiseChain = promiseChain.then(()=> promiseFactory(dataStructure));
    })

    return promiseChain;

    function promiseFactory(dataStructure){
      return system.createDatabaseTables(dataStructure.tableDefinition)
    }
  })
}

// load global config from database
function _loadGlobalConfigFromDatabase(){
  return new Promise((resolve, reject)=>{
    const pool = system.systemGlobal.get('pool');

    pool.getConnection((err, connection)=>{
      if(err){ return reject(new Error('_loadGlobalConfigFromDatabase: error creating database pool connection - \n', err.message)); }
      let query = 'SELECT ' + connection.escapeId('config') + ' FROM config LIMIT 1';
      connection.query(query, (err, results)=>{
        connection.release();
        if(err || !results.length){
          return reject(new Error('_loadGlobalConfigFromDatabase: error loading config from database - \n', err.message)); 
        }

        let config = JSON.parse(results[0].config);
        system.systemGlobal.updateConfig(config)
        .then(resolve)
        .catch(reject)
      })
    })
  })
}


// start logger
function _startLogger(){
  return new Promise((resolve, reject)=>{
    let Log = new system.Logger(system.systemGlobal.getConfig('siteName').replace(/ /g, '_'));
    Log.initialize()
    .then(resolve)
    .catch(reject);
  })
}

// add default cron tasks
function _initializeCronTasks(){

  let defaultCronTasks = [];

  const dummyCronTask = {
    name: 'dummy cron task - please replace with real ones e.g. submitting sitemap, etc',
    run: function(app, req, res, callback){ return callback(null, true);},
    freq: 30,  // time in seconds
  };

  const mailQueueCronTask = {
    name: 'send email from queue',
    run: system.processMailQueue,
    freq: 30
  }

  defaultCronTasks.push(dummyCronTask, mailQueueCronTask);

  // add backup cron tasks if a backupDestination has been set
  if(system.systemGlobal.getConfig('backupDestination')){
    return system.addCronTasks(defaultCronTasks)
    .then(system.setBackupCronTask)
  } else {
    return system.addCronTasks(defaultCronTasks);
  }
}


// add default trigger
function _initializeTriggers(){
  let defaultTriggers = [];

  /* triggers have the following structure
   * {
   *   name: 'unique identifier',
   *   actions: [action1, action2, etc] // list of actions to be executed each time trigger occurs
   * }
   *
   * actions have the structure
   *  {
   *    name: 'unique identifier',
   *    run: function_that_returns_a_promise
   *  }
   */
  const userAccountCreatedTrigger = {
    name: 'user account created',
    actions: []
  };

  const userAccountDeletedTrigger = {
    name: 'user account deleted',
    actions: []
  };

  defaultTriggers.push(userAccountCreatedTrigger, userAccountDeletedTrigger);
  return system.addTriggers(defaultTriggers);
}


/*
 * start installation sequence
 * 
 * @param {object} siteConfig - req.body from site_install form
 * @api public
 */
exports.startInstall = startInstall;

function startInstall(app, req){
  req.body.host = 'localhost';  // add host to req.body

  return _createDatabasePool(req.body)
  .then(_createDefaultDatabaseTables)
  .then(system.createCronKey)
  .then(_createAndLoginAdminUser.bind(null, req))
  .then(_createHandyConfigFile.bind(null, app))
  .then(_updateSystemConfig.bind(null, req))
  .then(_runProjectInstall)
  .then(initialize.bind(null, app))
  .catch((err)=> Promise.reject(err))
}


/*
 * create cron path
 * creates random string which is used as the path to run cron e.g. /cron/random_string
 * adds a level of security through obscurity to the app
 */
/*
functionality moved to system module
function _createCronKey(){
  const cronKey = utility.generateRandomString(30);
  return system.systemGlobal.updateConfig({cronKey});
}
*/

/*
 * create admin user and log them in
 *
 * @param {object} config - user configuration
 */

function _createAndLoginAdminUser(req){
  const config = req.body;
  let admin = new user.User({});
  admin.name = config.adminName;
  admin.email = config.adminEmail;
  admin.authenticated = true;
  admin.verified = true;
  admin.creator = 1;
  admin.roles = ['admin'];
  admin.createdate = new Date();
  admin.lastlogin = admin.createdate;

  return admin.hashPassword(config.adminPassword)
  .then(()=> admin.save())    // need to call admin method this way in order to be able to preserve value of 'this'
  .then(()=> admin.login(req))
  .catch((err)=>{
    return Promise.reject(err);
  })
}

/*
 * create config file
 * contains db access credentials which are used to bootstrap the app
 *
 */

function _createHandyConfigFile(app){
  return new Promise((resolve, reject)=>{

    const dbConfig = {
      dbName: system.systemGlobal.get('database'),
      dbUser: system.systemGlobal.get('databaseUser'),
      dbPassword: system.systemGlobal.get('databasePassword')
    }

    const handy_config_file = app.get('handy_config_file');

    fs.writeFile(handy_config_file, JSON.stringify(dbConfig, null, 2), {encoding: 'utf8', mode: 384}, (err)=>{
      if(err){return reject(err); }
      return resolve();
    })
  })
}


// update system config
function _updateSystemConfig(req){
  const {siteName, siteEmail} = req.body;
  
  // get site URL
  const siteURL = req.protocol + '://' + req.hostname

  system.systemGlobal.set('installation_flag', true);
  return system.systemGlobal.updateConfig({siteName, siteEmail, siteURL})
}


// run any additional project installation functions
// these are programatically set functions
function _runProjectInstall(){
  let installFunctions = system.systemGlobal.get('additional_install_functions');
  // stop processing if installFunctions is not an array or is an empty array
  if(!Array.isArray(installFunctions) || !installFunctions.length){
    return Promise.resolve();
  }

  let promiseChain = Promise.resolve();
  installFunctions.forEach((installFunction)=>{
    promiseChain = promiseChain.then(()=> promiseFactory(installFunction));
  })

  return promiseChain;

  function promiseFactory(installFunction){
    return installFunction();
  }
}


// set default configurations
function _setDefaultConfiguration(){
  return new Promise((resolve, reject)=>{
    const defaultConfig = {
      cronRecords: {},
      siteSupportEmail: '',
      emailAgent: 'mail_server',
      mandrillApiKey: '',
      siteEmailUsername: '',
      siteEmailPassword: '',
      siteEmailHost: '',
      siteEmailPort: '',
      siteEmailSSL: false,
      siteEmailTLS: true,
      siteEmailTimeout: '',
      logDestination: '',
      reportFreq: 1,
      reportDestination: '',
      logViewDefinitions: [
        {id: 'level', definition: 'level'},
        {id: 'method', definition: 'req.method'},
        {id: 'category', definition: 'category'},
        {id: 'user', definition: 'user'},
      ],
      googleClientId: '',
      googleClientSecret: '',
      googleAuthRedirectURIPath: 'google_auth_redirect',
      googleAuthScopes: '',
      gmailSendBuffer: 60,  // number of seconds to wait between email send requests
      siteGoogleAuthAccessToken: {},
      backupFreq: 24,  // time in hours
      backupDestinationType: 'email',  // 'email' or 'file'
      backupDestination: '',  // email address or file path
    };
/*
    const defaultConfig = {
      defaultFrontPage: '',
      default404Page: '',
      default403Page: '',
      welcomePage: '',

      googleAnalyticsId: '',


      anonUser: 'anonymous',
      deletedUser: 'deleted',
      registerAuthority: 'visitor',
      emailVerify: true,
      welcome_new_user_admin_subject: 'Welcome to [site:name]',
      welcome_new_user_admin_body: 'Hi,\n\nYour account on [site:name] is ready.\n\n[site:name] does all these cool stuff.\n\nYou may now log in by clicking this link or copying and pasting it into your browser.\n\n[user:one-time-login-url]\n\nThis link can only be used once and expires in 24 hours.  Clicking this link will lead you to a page where you can set your password.\n\nAfter setting your password, you will be able to log in at [site:url] in the future using:\n\nemail: [user:email]\npassword: Your password\n\nThank you and hope you enjoy using [site:name].\n\n[site:name] team',
      welcome_new_user_approval_required_subject: 'Account details for [user:name] at [site:name] (pending admin approval)',
      welcome_new_user_approval_required_body: '[user:name],\n\nThank you for registering at [site:name]. Your application for an account is currently pending approval. Once it has been approved, you will receive another e-mail containing information about how to log in, set your password, and other details.\n\n--  [site:name] team',
      welcome_new_user_no_approval_required_subject: 'Welcome to  [site:name]',
      welcome_new_user_no_approval_required_body: 'Hi,\n\nThanks for checking out [site:name].\n\n[site:name] does all these cool stuff.\n\n\n\nThank you and hope you enjoy using [site:name].\n\n[site:name] team',
      welcome_new_user_email_verification_required_subject: 'Welcome to [site:name]',
      welcome_new_user_email_verification_required_body: 'Hi,\n\nThanks for checking out [site:name].\n\n[site:name] does all these cool stuff.\n\nPlease verify your email address by clicking this link or copying and pasting it into your browser.\n\n[user:one-time-email-verification-url]\n\nThank you and hope you enjoy using [site:name].\n\n[site:name] team',
      account_activation_checkbox: true,
      account_activation_subject: 'Account details for [user:name] at [site:name] (approved)',
      account_activation_body: '[user:name],\n\nYour account at [site:name] has been activated.\n\nYou may now log in by clicking this link or copying and pasting it into your browser:\n\n[user:one-time-login-url]\n\nThis link can only be used once to log in and will lead you to a page where you can set your password.\n\nAfter setting your password, you will be able to log in at [site:login-url] in the future using:\n\nemail: [user:email]\npassword: Your password\n\n--  [site:name] team',
      account_blocked_checkbox: false,
      account_blocked_subject: 'Account details for [user:name] at [site:name] (blocked)',
      account_blocked_body: '[user:name],\n\nYour account on [site:name] has been blocked.\n\n--  [site:name] team',
      account_cancel_request_subject: 'Account cancellation request for [user:name] at [site:name]',
      account_cancel_request_body: '[user:name],\n\nA request to cancel your account has been made at [site:name].\n\nYou may now cancel your account on [site:url-brief] by clicking this link or copying and pasting it into your browser:\n\n[user:cancel-url]\n\nNOTE: The cancellation of your account may not be reversible.\n\nThis link expires in one day and nothing will happen if it is not used.\n\n--  [site:name] team',
      account_cancelled_checkbox: false,
      account_cancelled_subject: 'Account details for [user:name] at [site:name] (cancelled)',
      account_cancelled_body: '[user:name],\n\nYour account on [site:name] has been cancelled.\n\n--  [site:name] team',
      password_recovery_subject: 'Replacement login information for [user:name] at [site:name]',
      password_recovery_body: '[user:name],\n\nA request to reset the password for your account has been made at [site:name].\n\nYou may now log in by clicking this link or copying and pasting it to your browser:\n\n[user:one-time-login-url]\n\nThis link can only be used once to log in and will lead you to a page where you can set your password. It expires after one day and nothing will happen if it\'s not used.\n\n--  [site:name] team',
      email_verification_resend_subject: 'Please verify your email for [site:name]',
      email_verification_resend_body: '[user:name],\n\nAn email verification request has been made for your account at [site:name].\n\nPlease verify your email address by clicking this link or copying and pasting into your browsser:\n\n[user:one-time-email-verification-url]\n\nThank you.\n\n[site:name] team',
      initialObjectList: {
        user: user.User,
        contentList: content.ContentList
      },
      contentTypeList: {
        Category: content.Category,
        Story: content.Story,
        Comment: content.Comment
      },
      resourcePermissionList: {
        system: {
          System: ['Can run tests', 'Can alter system configuration']
        },
        user:{
          "*": ["Can modify own account", "Can modify other users' accounts", "Can create new roles", "Can modify roles", "Can grant roles"],
          User: []
        },
        content:{
          "*": ["Can view content", "Can create draft content", "Can create new content", "Can modify own content only", "Can modify any content", "Can delete own content only", "Can delete any content"],
          Story: [],
          Comment: [],
          Category: []
        }
      },
      rolesPermissionGrant: {
        administrator: {'all': ['all']},
        unauthenticated: {
          "content.Story": ['Can view content'],
          "content.Comment": ['Can view content']
        },
        authenticated: {
          "user.User": ['Can modify own account'],
          "content.Story": ["Can view content", "Can create draft content"],
          "content.Comment": ["Can view content", "Can create draft content"]
        },
        verified: {
          "user.User": ['Can modify own account'],
          "content.Story": ["Can view content", "Can create new content", "Can create draft content", 'Can modify own content only', 'Can delete own content only'],
          "content.Comment": ["Can view content", "Can create new content", "Can create draft content", 'Can modify own content only', 'Can delete own content only']
        },
        editor:{
          "user.User": ['Can modify own account'],
          "content.Story": ["Can view content", "Can create new content", "Can create draft content", "Can modify own content only", "Can modify any content", "Can delete own content only", "Can delete any content"],
          "content.Comment": ["Can view content", "Can create new content", "Can create draft content", "Can modify own content only", "Can modify any content", "Can delete own content only", "Can delete any content"],
          "content.Category": ["Can view content", "Can create new content", "Can create draft content", "Can modify own content only", "Can modify any content", "Can delete own content only", "Can delete any content"]
        },
        org_admin:{
          "user.User": ['Can modify own account', "can modify other users' accounts"]
        }
      },
      sitemapSubmit: false,
      sitemapConfig:{
        content: {
          Story: {freq: 'hourly', priority: '0.8'},
          Comment: {freq: 'daily', priority: '0.2'},
          Category: {}
        },
        default: {
          freq: 'weekly',
          priority: '0.5'
        }

      },
      categoryList: {},
      alias: {},
      cronRecords: {
        path:'',
        task: {}
      },
      theme: {
        head: _defaultConfig.bind([])('theme_head'),
        section_header: _defaultConfig.bind([])('theme_section_header'),
        section_messages: _defaultConfig.bind([])('theme_messages'),
        section_footer: _defaultConfig.bind([])('theme_section_footer'),
        section_bottomscripts: _defaultConfig.bind([])('theme_section_bottomscripts'),
        section_extras: _defaultConfig.bind([])('theme_section_extras'),
      },
      themeTemplateDefault: {
        head: _defaultConfig.bind([])('theme_head'),
        section_header: _defaultConfig.bind([])('theme_section_header'),
        section_messages: _defaultConfig.bind([])('theme_messages'),
        section_footer: _defaultConfig.bind([])('theme_section_footer'),
        section_bottomscripts: _defaultConfig.bind([])('theme_section_bottomscripts'),
        section_extras: _defaultConfig.bind([])('theme_section_extras'),
      },
      robotsTxt: 'user-agent: *\nDisallow: /install\nDisallow: /configuration\nDisallow: /accessdenied\nDisallow: /notfound\nDisallow: /cron\nDisallow: /verifyemail\nDisallow: /requestonetimelink\nDisallow: /onetimelogin\nDisallow: /password\nDisallow: /user\nDisallow: /cancelaccount\nDisallow: /content/create\nAllow: /\n\n# Sitemap: (uncomment line and insert absolute url of sitemap here - e.g. http://hostname/sitemap.xml)',
      cacheKey: {}
    }
*/

    _.forEach(defaultConfig, (val, key)=>{
      system.systemGlobal.config[key] = val;
    })

    return resolve();
  })
}