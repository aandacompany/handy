/*
 * Main module for handyjs 
 */

'use strict';

const express = require('express')
  , compression = require('compression')
  , session = require('express-session')
  , cookieParser = require('cookie-parser')
  , bodyParser = require('body-parser')
  , methodOverride = require('method-override')
  , morgan = require('morgan')
  , csrf = require('csurf')
  , RedisStore = require('connect-redis')(session)
  , path = require('path')
  , process = require('process')
  , system = require(path.join(__dirname, 'system'))
  , utility = require(path.join(__dirname, 'utility'))
  , user = require(path.join(__dirname, 'user'))
  , bootstrap = require(path.join(__dirname, 'bootstrap'))
  ;

// define exports
exports.system = system;
exports.utility = utility;
exports.user = user;
exports.bootstrap = bootstrap;

// handy initialize function
exports.initialize = initialize;

function initialize(app){
  // check working mode i.e. 'production' or 'development'
  app.set('environment', process.env.NODE_ENV);

  // log any unhandled promise rejections to console
  process.on('unhandledRejection', (reason, p) => {
    if(app.get('environment') !== 'production'){
console.log('Unhandled Rejection at: Promise', p, '\nreason:', reason);
    }
  });

  return bootstrap.initialize(app)   // set up various config files, establish database, etc
  .then(bootstrap.secretStrings.bind(null, app))     // create random strings used for secret keys, redis db prefix, etc
  .then(_configureExpressSession.bind(null, app))
  .then(({app, secretStrings})=>{
    return new Promise((resolve, reject)=>{

      // flag to indicate handy is operating under module development mode
      // i.e. true if handy is installed via npm link rather than npm install
      app.set('handy_module_development_status', process.env.MODULE_DEV_HANDY || false);

      app.use(compression()); // gzips responses

      // set project specific express configuration
      /* for security reasons, nodejs should only listen to ports above 1000
       * (assuming, of course, nodejs is running behind a reverse proxy)
       * this is because only users (system users, that is) with root access
       * can run services that bind to ports under 1000.  Node should not be
       * run by a user with root access, so the only ports available are above 1000
       */

      const defaultPort = 2000;
      // set environment variable PORT appropriately for sites hosted on the same server
      app.set('port', process.env.PORT || defaultPort);

      app.set('views', [path.join(__dirname, '..', 'views')]);
      app.set('view engine', 'pug');

      app.use(morgan('dev'));

      app.use(cookieParser(secretStrings.cookieSecret));

      // custom middleware to  make req.rawBody available
      app.use(function(req, res, next){
        req.rawBody = '';
        req.on('data', function(chunk){
            req.rawBody += chunk;
        });

        next();
      });

      // enable access to form content via req.body
      app.use(bodyParser.urlencoded({extended: false, limit: '50mb'}));
      app.use(bodyParser.json({limit: '50mb'}));

      // needs to be before any module that needs to know the method of a request e.g. csurf
      app.use(methodOverride());

      // disable "x-powered-by" header for security
      app.disable("x-powered-by");
      
      // middleware to set req.session.user.id to zero for unauthenticated users
      app.use(system.initializeUnauthenticatedUsers);

      // middleware to exclude certain routes from CSRF protection
      // useful if those routes are called directly from 3rd parties e.g. webhooks
      system.systemGlobal.set('bypass_csrf_path', '/handy-ncsrf');

      const csrfExcludedRoutes = ['/handy-ncsrf'];
      app.use((req, res, next)=>{
        let pathMatch = false;  // assume path requires CSRF
        csrfExcludedRoutes.forEach((route)=>{

          if(route === req.path.substr(0, route.length)){
            pathMatch = true;
          }
        })

        pathMatch ? next() : csrf({cookie: {
          secure: true,
          sameSite: 'none',
          httpOnly: true,
        }})(req, res, next);
      })

      // middleware to set csrf token to be used in forms
      app.use((req, res, next)=>{
        let pathMatch = false;  // assume path requires CSRF
        csrfExcludedRoutes.forEach((route)=>{
          if(route === req.path.substr(0, route.length)){
            pathMatch = true;
          }
        })

        if(pathMatch){
          next()
        } else {
          res.locals.token = req.csrfToken();
          next();
        }
      })

      // terminate all requests (except public files) by displaying installation form
      // if handy installation is not complete
      app.use(system.checkInstallation.bind(null, app));

      // get system messages (should be just above the route statements to ensure all system messages are collected)
      app.use(system.systemMessage.get);


      // get current version (used for things like attaching version numbers to js and css files)
      const handy_version = require(path.join(__dirname, '..', 'package.json')).version;
      let handyModuleVersions = system.systemGlobal.get('handy_module_versions') || {};
      handyModuleVersions.handy_version = handy_version;
      system.systemGlobal.set('handy_module_versions', handyModuleVersions);

      // set path to handy directory (for use when creating files, etc)
      const handyDirectory = path.join(__dirname, '..');
      system.systemGlobal.set('handyDirectory', handyDirectory);

      return resolve();
    })
  })
  .then(_setRoutes.bind(null, app))
  .catch((err)=>{
    return Promise.reject(new Error('handyjs initialization error - \n' + err.stack));
  })

}

function _configureExpressSession(app, secretStrings){
  return new Promise((resolve, reject)=>{
    const appProtocol = process.env.APP_PROTOCOL || 'https';  // assume app is running an https server
    const secure = appProtocol === 'https' ? true : false;


    // redis settings
    const defaultRedisDb = 1  // redis db will be modified by environment variables as needed
    , defaultRedisPort = 6379
    , defaultRedisHost = 'localhost'
    , redisOptions = {
      host: process.env.REDIS_HOST || defaultRedisHost,
      port: parseInt(process.env.REDIS_PORT || defaultRedisPort),
      db: parseInt(process.env.REDIS_DB || defaultRedisDb),
      prefix: secretStrings.redisPrefix
    };

    const sessionStore = new RedisStore(redisOptions);
    
    sessionStore.on('disconnect', function(){
console.log('Redis connection lost...');
    });

    sessionStore.on('connect', function(){
console.log('Redis connection established...');
    });

    // store session data in redis
    app.use(session({
      resave: false,
      saveUninitialized: true,
      store: sessionStore,
      secret: secretStrings.sessionSecret,
      cookie: {
        sameSite: 'None',
        secure: secure
      }
    }));

    return resolve({app, secretStrings});
  })
}




// set routes
function _setRoutes(app){
  return new Promise((resolve, reject)=>{
    const routes = require(path.join(__dirname, '..', 'routes'))(app);

    // set up public directory
    app.use(express.static(path.join(__dirname, '..', 'public')));

    return resolve();
  })
}


/*
 * Add new view directories to express applications
 *
 * @param {obj} app - express app object
 * @param {string} view - path to view directory
 * @api public
 */
exports.addViews = addViews;

function addViews(app, view){
  let currentViews = app.get('views');
  currentViews.push(view);
  return app.set('views', currentViews);
}

/*
 * Add functions to be executed after handy installation is complete
 * can be used to run installation for other apps built on handy
 * NOTE: functions need to be wrapped as promises
 *
 * @param {promise or array} installFunctions - additional functions to be executed
 * @api public
 */
exports.addInstallFunctions = addInstallFunctions;

function addInstallFunctions(installFunctions){
  return new Promise((resolve, reject)=>{
    let installFunctionList = system.systemGlobal.get('additional_install_functions') || [];
    if(Array.isArray(installFunctions)){
      installFunctions.forEach((installFunction)=>{
        installFunctionList.push(installFunction);
      })
    } else {
      installFunctionList.push(installFunctions);
    }

    system.systemGlobal.set('additional_install_functions', installFunctionList);  // update additional_install_functions 
    return resolve();
  })
}
