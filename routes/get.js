'use strict';

const path = require('path')
  , fs = require('fs')
  , os = require('os')
  , express = require('express')
  , system = require(path.join(__dirname, '..', 'lib', 'system'))
  , user = require(path.join(__dirname, '..', 'lib', 'user'))
  ;

module.exports = function(app){

  const handyRouter = express.Router();
  const ncsrfRouter = express.Router();


  // site configuration
  handyRouter.get('/configuration', user.isAuthenticated, (req, res)=>{
    system.setCDNHeaders(res);
    let pageInfo = system.prepRender(req, res);
    pageInfo.configurationViews = system.systemGlobal.get('configuration_views') || {};
    res.render('configuration', {pageInfo});
    system.log({req, level: 'info', category: 'system', msg: 'configuration displayed', user: req.session.user.id});
  })


  // user login
  handyRouter.get('/login', (req, res)=>{
    let pageInfo = system.prepRender(req, res);
    // check if user is logged in already, if so, redirect to front page
    const authenticatedStatus = user.isAuthenticated(req, res);

    if(authenticatedStatus){
      const alert = {type: 'info', text: 'user is already logged in'};
      system.systemMessage.set(alert, req, res);
      return res.redirect('/');        
    } else {
      system.systemMessage.get(req, res);
      res.render('login', {pageInfo})
    }
  })


  // user logout
  handyRouter.get('/logout', user.isAuthenticated, (req, res)=>{
    system.setCDNHeaders(res);
    let logoutUser = new user.User(req.session.user);
    logoutUser.logout(req)
    .then(()=> {
      res.redirect('/');
      system.log({req, level: 'info', category: 'user', msg: 'user logout', user: logoutUser.id});
    })
    .catch((err)=>{
      const alert = {type: 'danger', text: 'something went wrong trying to logout - ' + err.message};
      system.systemMessage.set(alert, req, res);
      res.redirect('back');
      system.log({req, level: 'error', category: 'user', msg: 'error logging out user', user: logoutUser.id, err});
    })
  })


  // password rest
  handyRouter.get('/resetpassword/:onetimelink', (req, res)=>{
    let pageInfo = system.prepRender(req, res);

    let referenceUser = new user.User({email: req.query.email});
    let resetUser = new user.User({email: req.query.email});
    resetUser.onetimelink = encodeURIComponent(req.params.onetimelink);
    resetUser.createOneTimeLink('password', true)
    .then(()=> referenceUser.load(['email']))
    .then(()=>{
      return new Promise((resolve, reject)=>{
        // check that one time link exists
        if(!referenceUser.onetimelink){return reject(new Error('there is no existing request for this user'))}

        // check the one time link has not expired
        const now = Date.now();
        if(now > referenceUser.onetimelinktimestamp.getTime()){return reject(new Error('password reset request link has expired.  please make a new request'))}
        // check the one time links match
        if(resetUser.onetimelinkhash === referenceUser.onetimelinkhash){
          return resolve();
        } else {
          return reject(new Error('password reset url is incorrect.  please ensure you copied the link correctly.  if the issue persists, you can make a new password reset request'))
        }
      })
    })
    .then(()=>{
      pageInfo.resetUserEmail = resetUser.email;
      // save email in session, for security reasons, so it can be recovered when the form is submitted
      req.session.user = req.session.user || {};
      req.session.user.email = resetUser.email;

      res.render('passwordreset', {pageInfo})
      system.log({req, level: 'info', category: 'user', msg: 'password reset url validated', user: referenceUser.id});
    })
    .catch((err)=>{
      const alert = {type: 'danger', text: err.message};
      system.systemMessage.set(alert, req, res);
      res.redirect('/handy/login?tab=reset');
      system.log({req, level: 'error', category: 'user', msg: 'password reset url validation error - ' + err.message , user: resetUser.email, err});
    })
  })


  // display user profile
  handyRouter.get('/user/:id?', user.isAuthenticated, (req, res)=>{
    system.setCDNHeaders(res);
    let id;
    if(!req.params.id){
      id = req.session.user.id;
    } else {
      id = Number.parseInt(req.params.id, 10);
    }

    let profileUser = new user.User({id});
    let sessionUser = new user.User({id: req.session.user.id})

    return new Promise((resolve, reject)=>{
      // stop processing if id is not a number
      if(Number.isNaN(id)){return reject(new Error('user id must be a valid number'))}
      return resolve();
    })
    .then(()=> profileUser.load(['id']))
    .then(()=> sessionUser.load(['id']))
    .then(()=>{
      // only allow admins to view other user's profiles
      return new Promise((resolve, reject)=>{
        if(req.session.user.id !== profileUser.id && !user.hasRoles(sessionUser, ['admin'])){
          return reject(new Error('you do not have permission to view this user profile'))
        }

        return resolve();
      })
    })
    .then(()=>{
      let pageInfo = system.prepRender(req, res);
      pageInfo.profileUser = profileUser;
      pageInfo.config.displayProfile = true;
      res.render('userprofile', {pageInfo});
      system.log({req, level: 'info', category: 'user', msg: 'user profile displayed', user: profileUser.id});
    })
    .catch((err)=>{
      const alert = {type: 'danger', text: err.message};
      system.systemMessage.set(alert, req, res);
      let pageInfo = system.prepRender(req, res);
      pageInfo.config.displayProfile = false;
      res.render('userprofile', {pageInfo});
      system.log({req, level: 'error', category: 'user', msg: 'error displaying user profile - ' + err.message , user: profileUser.id, err});

    })


  })

  // cron
  handyRouter.get('/cron/:cronKey?/:reset?', (req, res)=>{
    system.setCDNHeaders(res);
    res.status(200).send('done');  // send response irrespective of correctly provided cronKey
      const cronKey = system.systemGlobal.getConfig('cronKey');
      cronKey === req.params.cronKey ? req.params.reset === 'reset' ? system.createCronKey() : system.runCron(app, req, res) : null;
  })


  // log viewing
  handyRouter.get('/logs/:view?/:age?', user.isAuthenticated, (req, res)=>{
    const view = req.params.view || 'html';
    const age = req.params.age || 1;  // maximum age (in days) of oldest log record

    switch(view){
      case 'json':
        system.setCDNHeaders(res);
        const logFile = system.systemGlobal.getConfig('logDestination') || system.systemGlobal.getConfig('logFileDefaultDestination');
        _findLogFiles(logFile)
        .then((currentLogFiles)=> _readLogFile(currentLogFiles, age))
        .then((logArray)=> _filterLogs(logArray, {age}))  
        .then((logArray)=>{
          const filters = _getFilterValues(logArray);
          res.send(JSON.stringify({logs: logArray, filters}));
        })
        .catch((err)=>{
          res.send({err: err.stack});
        })

        break;
      case 'html':
      default:
        let pageInfo = system.prepRender(req, res);
        pageInfo.logViewDefinitions = system.systemGlobal.getConfig('logViewDefinitions');
        res.render('logviewer', {pageInfo})
    }
  })

  // google account connection
  handyRouter.get('/google_auth', user.isAuthenticated, (req, res)=>{
    let pageInfo = system.prepRender(req, res);
    const googleClientId = system.systemGlobal.getConfig('googleClientId');
    const googleClientSecret = system.systemGlobal.getConfig('googleClientSecret');
    const oauthRedirectUrl = user.getGoogleOauthRedirectUrl();

    pageInfo.oauthRedirectUrl = oauthRedirectUrl;
    res.render('googleAuth', {pageInfo});
  })

  // redirect after user has authorized (or denied) access to Google account
  const googleAuthRedirectURIPath = system.systemGlobal.getConfig('googleAuthRedirectURIPath')
  handyRouter.get('/' + googleAuthRedirectURIPath, user.isAuthenticated, (req, res)=>{

    // check if user denied access
    if(req.query.error){
      const alert = {type: 'danger', text: 'access to your Google account was denied - ' + req.query.error};
      system.systemMessage.set(alert, req, res);
      res.redirect('/handy/google_auth');
      return;
    }

    user.getGoogleOauthTokens(req.query.code)
    .then((tokens)=>{
      // if user is not an admin, save tokens to user account and redirect to front page
      let authUser = new user.User(req.session.user);
      return authUser.load(['id'])
      .then(()=>{
        return new Promise((resolve, reject)=>{
          // if user is not an admin, update their user record and save
          const isAdmin = user.hasRoles(authUser, 'admin');
          if(!isAdmin){
            authUser.googleauthtoken = tokens;
            authUser.save()
            .then(()=>{
              const alert = {type: 'success', text: 'Google account successfully connected'};
              system.systemMessage.set(alert, req, res);
              res.redirect('/');
              system.log({req, level: 'info', category: 'user', msg: 'google account connected', user: authUser.id});
              return resolve();
            })
            .catch(reject)
          } else {
            let pageInfo = system.prepRender(req, res);
            // display choice to connect to user account or overall site
            req.session._tokens = tokens;  // save tokens
            res.render('googleAuthChoice', {pageInfo});
            return resolve();
          }
        })
      })
    })
    .catch((err)=>{
      const alert = {type: 'danger', text: 'error connecting google account - ' + err.message};
      system.systemMessage.set(alert, req, res);      
      res.redirect('/');
      system.log({req, level: 'error', category: 'user', msg: 'error connecting google account', err});
    })
  })

  // provide choice to admins to connect google account to personal account or site
  handyRouter.get('/google_auth_choice', user.isAdmin, (req, res)=>{
    system.setCDNHeaders(res);
    const tokens = req.session._tokens;  // retrieve saved tokens
    const siteAuth = req.query.site === 'true' ? true : false;

    if(siteAuth){
      // if site then, save to config
      system.systemGlobal.updateConfig({siteGoogleAuthAccessToken: tokens})
      .then(()=>{
        const alert = {type: 'success', text: 'Google account successfully connected to site'};
        system.systemMessage.set(alert, req, res);
        res.redirect('/handy/configuration');
        system.log({req, level: 'info', category: 'system', msg: 'google account connected to site'});
      })
    } else {
      // if user, save to user account
      let authUser = new user.User(req.session.user);
      authUser.load('id')
      .then(()=>{
        authUser.googleauthtoken = tokens;
        authUser.save()
        .then(()=>{
          const alert = {type: 'success', text: 'Google account successfully connected'};
          system.systemMessage.set(alert, req, res);
          res.redirect('/');
          system.log({req, level: 'info', category: 'user', msg: 'google account connected', user: authUser.id});
        })
        .catch(reject)
      })
    }
  })

  app.use('/handy', handyRouter);


  /******************************************************************************************/
  /******************************** CSRF Excluded Routes ************************************/
  /******************************************************************************************/

  ncsrfRouter.get('/', (req, res)=>{
    res.send('excludedRoutes<br>token: ' + res.locals.token)
  })


  // declare routers
  app.use('/handy-ncsrf', ncsrfRouter);  // routes without CSRF protection
}



/****************** helper functions for path '/logs/:view?/:age?'  *************/

// find list of log files ie. .log, .log.0, .log.1, etc
function _findLogFiles(baseFile, logFileArray=[], ctr=-1){
  return new Promise((resolve, reject)=>{
    // check if log file exists
    let currentFileToCheck = baseFile;
    if(ctr >= 0){
      currentFileToCheck += '.' + ctr; 
    }

    fs.stat(currentFileToCheck, (err, stats)=>{
      if(err){
        return resolve(logFileArray)
      }
      ctr++;
      logFileArray.push(currentFileToCheck);
      return resolve(_findLogFiles(baseFile, logFileArray, ctr));
    })
  })
}


// read log files into array of objects
function _readLogFile(files=[], age){
  return new Promise((resolve, reject)=>{
    let promiseArray = [];
    files.forEach((file)=>{
      promiseArray.push(

        new Promise((resolve1, reject1)=>{
          let logStream = fs.createReadStream(file);
          let logText = '';
          let logArray = [];

          logStream.on('data', (data)=>{
            logText += data;
            _extractLogLine(logText, logArray)
            .then((logOutput)=> {
              logText = logOutput.text;
              logArray - logOutput.logArray;
            })
            .catch(reject1)
          })

          logStream.on('end', ()=>{
            if(logText.length){
              _extractLogLine(logText, logArray)
              .then((logOutput)=> {
                logText = logOutput.text;
                logArray = logOutput.logArray;
                resolve1(logArray)
              })
              .catch(reject1)
            } else {
              resolve1(logArray);
            }
          })
        })
      
      )

    })

    Promise.all(promiseArray)
    .then((arrayOfLogArrays)=>{
      const logArray = [].concat.apply([], arrayOfLogArrays);
      return resolve(logArray)
    })
    .catch(reject)
  })
}


function _extractLogLine(text, logArray){
  return new Promise((resolve, reject)=>{
    let newLineIndex = text.indexOf(os.EOL);
    if(newLineIndex === -1){ return resolve({text, logArray}); }
    
    let line = text.substring(0, newLineIndex);
    _processLogLine(line, logArray)
    .then((returnArray)=>{
      logArray = returnArray;
      text = text.substring(newLineIndex + os.EOL.length);
      return resolve(_extractLogLine(text, logArray));
    })
    .catch((err)=>{
      return resolve({text, logArray});  // dodgy code - could cause infinte loop
    })

  })
}


function _processLogLine(line, logArray){
  return new Promise((resolve, reject)=>{

    let logLineObject;

    try{
      logLineObject = JSON.parse(line);
      logArray.push(logLineObject);
      return resolve(logArray);
    }
    catch(err){
      logArray.push(new Error('error parsing log line'));
      return resolve(logArray);
    }
  })
}


// apply filters to log records
function _filterLogs(logs, filters){
  return new Promise((resolve, reject)=>{
    let filterFunction;
    let filteredLogs = logs;
    Object.keys(filters).forEach((filterKey)=>{
      switch(filterKey){
        case 'age':
          const now = Date.now();
          const maxAge = filters[filterKey];
          const oldestTimestamp = now - (maxAge * 24 * 60 * 60 * 1000);
          const tempLogArray = [];
          filteredLogs.forEach((log)=>{
            const logTime = Date.parse(log.time);
            logTime - oldestTimestamp > 0 ? tempLogArray.push(log) : null;
          })

          filteredLogs = tempLogArray;
          break;
        default:
      }
    })

    return resolve(filteredLogs);
  })
}


function _getFilterValues(logs){
  const logViewDefinition = system.systemGlobal.getConfig('logViewDefinitions');
  let logFilterDefinition = {};
  logViewDefinition.forEach((definition)=>{
    logFilterDefinition[definition.id] = {
      definition: definition.definition,
      values: []
    }
  })

  logs.forEach((log)=>{
    Object.keys(logFilterDefinition).forEach((id)=>{
      let value = _extractRecordValue(log, logFilterDefinition[id].definition);
      logFilterDefinition[id].values.push(value);
    })
  })

  // reduce values of each filter to only unique values
  Object.keys(logFilterDefinition).forEach((id)=>{
    let uniqueValues = logFilterDefinition[id].values.filter((item, pos)=>{
      return logFilterDefinition[id].values.indexOf(item) === pos;
    })
    logFilterDefinition[id].values = uniqueValues;
  })

  // convert from object into array of objects
  let returnArray = [];
  Object.keys(logFilterDefinition).forEach((id)=>{
    returnArray.push({
      id: id,
      values: logFilterDefinition[id].values,
      definition: logFilterDefinition[id].definition
    })
  })

  return returnArray;
}


function _extractRecordValue(record={}, definition=''){
  definition = definition.split('.');
  let returnValue = JSON.parse(JSON.stringify(record));  // clone record
  definition.forEach((prop)=>{
    returnValue = typeof returnValue !== 'undefined' ? returnValue[prop] : returnValue;
  })

  return returnValue;
}



/******************************************************************************/