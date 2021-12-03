'use strict';

let express = require('express')
  , path = require('path')
  , bootstrap = require(path.join(__dirname, '..', 'lib', 'bootstrap'))
  , utility = require(path.join(__dirname, '..', 'lib', 'utility'))
  , system = require(path.join(__dirname, '..', 'lib', 'system'))
  , user = require(path.join(__dirname, '..', 'lib', 'user'))
  ;

module.exports = function(app){
  const handyRouter = express.Router();

  app.post('/', (req, res)=>{
    res.send('post yay');
  })


  // site installation
  handyRouter.post('/site_install', (req, res)=>{
    delete req.body._csrf;
    req.body = utility.trimFormTextEntries(req.body);
    bootstrap.startInstall(app, req)
    .then(()=>{
      res.redirect('/handy/configuration');
      system.log({req, level: 'info', category: 'system', msg: 'site installation done'});
    })
    .catch((err)=>{
      system.systemMessage.set({type: 'danger', text: 'Installation failed - ' + err.message}, req, res);
      res.redirect('back');
      system.log({req, level: 'error', category: 'system', msg: 'site installation failed', err});
    });
  })


  // user login
  handyRouter.post('/login', system.throttle.bind(null, 'login', 5, app), (req, res)=>{
    delete req.body._csrf;
    let alert;
    let loginUser = new user.User({email: req.body.userEmail});
    loginUser.authenticate(req.body.userPassword)
    .then(()=>loginUser.login(req))
    .then(()=>{
      alert = {type: 'success', text: 'welcome ' + loginUser.name};
      system.systemMessage.set(alert, req, res);
      res.redirect('/handy/user');
      system.log({req, level: 'info', category: 'user', msg: 'user login successful', user: loginUser.id});
    })
    .catch((err)=>{
      alert = {type: 'danger', text: 'login failed.  please retry'};
      system.systemMessage.set(alert, req, res);
      res.redirect('back');
      system.log({req, level: 'error', category: 'user', msg: 'user login failed', user: loginUser.id, err});
    })
  })


  // user forgot password, requesting password reset instructions
  handyRouter.post('/forgotpassword', (req, res)=>{
    delete req.body._csrf;

    let resetUser = new user.User({email: req.body.userEmail});
    const typeOfUser = 'existing';
    const linkExpiryTime = 10;  // time, in minutes for link expiry
    resetUser.initiatePasswordReset(typeOfUser, linkExpiryTime)
    .then(()=>{
      const alert = {type: 'success', text: 'password reset instructions have been sent to the email address provided'};
      system.systemMessage.set(alert, req, res);
      res.redirect('back');
      system.log({req, level: 'info', category: 'user', msg: 'password reset instructions sent to ' + req.body.userEmail, user: resetUser.id});
    })
    .catch((err)=>{
      const alert = {type: 'danger', text: 'error sending password reset instructions: - ' + err.message};
      system.systemMessage.set(alert, req, res);
      res.redirect('back');
      system.log({req, level: 'error', category: 'user', msg: 'password reset initiation failed: ' + err.message, user: resetUser.id, err});
    })
  })


  // update user profile
  handyRouter.post('/userprofile', user.isAuthenticated, (req, res)=>{
    const name = req.body.userName.trim();
    const password = req.body.password.trim();
    const passwordConfirmation = req.body.passwordConfirmation.trim();
    
    const id = Number.parseInt(req.body.userId, 10);
    let profileUser = new user.User({id});
    return new Promise((resolve, reject)=>{
      // perform form validations

      // stop processing if name is blank
      if(!name){return reject(new Error('user name cannot be blank or just spaces'))}

      // stop processing if password change but password is not same as confirmation
      if(password && password !== passwordConfirmation){
        return reject(new Error('password must match confirmation'))
      }

      return resolve();
    })
    .then(()=>{
      // check user has permission to edit profile ie either user's own profile or is admin
      return profileUser.load(['id'])
      .then(()=>{
        return new Promise((resolve, reject)=>{
          if(profileUser.id === req.session.user.id || user.hasRoles(profileUser, ['admin'])){
            return resolve();
          } else {
            return reject(new Error('you do not have permission to update this user profile'))
          }
        })
      })
    })
    .then(()=>{
      profileUser.name = name;
      if(password){
        return profileUser.hashPassword(password)
        .then(()=> profileUser.save());
      } else {
        return profileUser.save();
      }
    })
    .then(()=>{
      const alert = {type: 'success', text: 'user profile successfuly updated'};
      system.systemMessage.set(alert, req, res);
      res.redirect('back');
      system.log({req, level: 'info', category: 'user', msg: 'user profile updated', user: profileUser.id});
    })
    .catch((err)=>{
      const alert = {type: 'danger', text: 'Error updating user profile<br>' + err.message};
      system.systemMessage.set(alert, req, res);
      res.redirect('back');
      system.log({req, level: 'error', category: 'user', msg: 'user profile update failed', err, user: profileUser.id});
    })

  })

  // site configuration
  handyRouter.post('/site_config', user.isAuthenticated, user.isAdmin, (req, res)=>{
    /*NOTE: Should check that user is authorized to access configuration routes */
    delete req.body._csrf;

    let config = {};

    // get text input
    const textFields = ['siteName', 'siteEmail', 'siteSupportEmail', 'siteEmailUsername', 
      'siteEmailPassword', 'siteEmailHost', 
      'mandrillApiKey', 'googleClientId', 'googleClientSecret', 
      'googleAuthRedirectURIPath', 'googleAuthScopes', 
      'emailAgent', 'logDestination', 'reportDestination', 'reportFreq', 
      'backupDestination', 'backupDestinationType'
    ];

    textFields.forEach((field)=>{
      config[field] = req.body[field];
    })
    
    // get radio buttons
    const radioFields = ['siteEmailSSL', 'siteEmailTLS'];

    radioFields.forEach((field)=>{
      config[field] = req.body[field] === 'true' ? true : false;
    })

    // numerical fields
    const numericalFields = ['siteEmailPort', 'siteEmailTimeout', 
      'gmailSendBuffer', 'backupFreq'
    ];
    
    numericalFields.forEach((field)=>{
      // if provided, convert to integer and save
      if(field !== ''){
        if(!Number.isNaN(Number.parseInt(req.body[field], 10))){
          config[field] = Number.parseInt(req.body[field], 10);
        }
      }
    })

    system.systemGlobal.updateConfig(config)
    .then(()=>{
      // set the backup cron tasks
      return new Promise((resolve, reject)=>{
        const {backupDestination, backupFreq, backupDestinationType }= system.systemGlobal.getConfig();
        if(!backupDestination){return resolve(); } // stop processing if not backup destination
        system.setBackupCronTask()
        .then(resolve)
        .catch(reject);
      })
    })
    .then(()=>{
      const alert = {type: 'success', text: 'Configuration updated'};
      system.systemMessage.set(alert, req, res);
      res.redirect('back');
      system.log({req, level: 'info', category: 'system', msg: 'site configuration updated'});
    })
    .catch((err)=>{
      const alert = {type: 'danger', text: 'Error updating configuration<br>' + err.message};
      system.systemMessage.set(alert, req, res);
      res.redirect('back');
      system.log({req, level: 'error', category: 'system', msg: 'site configuration update failed', err});
    })
  })


  // create a new user account
  handyRouter.post('/createuser', user.isAuthenticated, user.isAdmin, (req, res)=>{
    let newUser = new user.User({email: req.body.userEmail});
    newUser.creator = 1;  // created by admin
    newUser.name = req.body.userEmail.split('@')[0];
    newUser.verified = true;  // no need for email verification since created by admin
    newUser.deleted = false;
    const now = new Date();
    newUser.lastlogin = now;
    newUser.createdate = now;
    newUser.modifydate = now;

    // need to provide a temporary password so the user account can be created
    // will be overwritten almost immediately
    const tempPassword = utility.generateRandomString(30);
    
    const typeOfUser = 'new';
    const linkExpiryTime = 24 * 60;  // time, in minutes, when user needs to activate account 
    newUser.hashPassword(tempPassword)
    .then(()=> newUser.save())
    .then(()=> newUser.initiatePasswordReset(typeOfUser, linkExpiryTime))
    .then(()=>{
      const alert = {type: 'success', text: 'new user account created'};
      system.systemMessage.set(alert, req, res);
      res.redirect('back');
      system.log({req, level: 'info', category: 'user', msg: 'new user account created', user: newUser.id});
    })
    .catch((err)=>{
      const alert = {type: 'danger', text: 'Error creating new user account<br>' + err.message};
      system.systemMessage.set(alert, req, res);
      res.redirect('back');
      system.log({req, level: 'error', category: 'user', msg: 'error creating new user account', err});
    })
  })


  /*
   * modify user password
   * 
   * type - can be 'change' or 'reset'
   *        'change' is when the user knows the current password
   *        'reset' is when the user does not know the current password
  */
  handyRouter.post('/password/:type', (req, res)=>{
    // NOTE: ONLY password reset has been implemented
    const email = req.session.user.email;
    const password = req.body.userPassword.trim();
    const passwordConfirmation = req.body.userPasswordConfirmation.trim();
    let resetUser = new user.User({email});    
    
    // validate password
    return new Promise((resolve, reject)=>{
      if(!password || password !== passwordConfirmation){return reject(new Error('password and password confirmation must match'))}
      resolve();
    })
    .then(()=> resetUser.load(['email']))
    .then(()=> resetUser.hashPassword(password))
    .then(()=>{
      resetUser.onetimelink = null;
      resetUser.onetimelinkhash = null;
      resetUser.onetimelinktimestamp = null;
      return resetUser.save();
    })
    .then(()=> {
      const alert = {type: 'success', text: 'user password successfuly reset.  please log in with the new password'};
      system.systemMessage.set(alert, req, res);
      res.redirect('/handy/login');
      system.log({req, level: 'info', category: 'user', msg: 'user password reset successful', user: resetUser.id});
    })
    .catch((err)=>{
      const alert = {type: 'danger', text: 'Error reseting user password<br>' + err.message};
      system.systemMessage.set(alert, req, res);
      res.redirect('/handy/login');
      system.log({req, level: 'error', category: 'user', msg: 'error reseting user password', err, user: resetUser.id});
    })



  })

  app.use('/handy', handyRouter);
}