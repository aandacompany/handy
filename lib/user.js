/*
 * User definition and management for handyjs
 */

'use strict';

const path = require('path')
  , crypto = require('crypto')
  , system = require(path.join(__dirname, 'system'))
  , googleAuth = require('google-auth-library')
  , _ = require('underscore')
  ;

// User object
class User extends system.BaseClass {
  constructor({id=null, name=null, email=null, salt=null, verified=false, roles=[], deleted=false, googleauthtoken={}, googleauthrefreshtoken=''}, runtimeExtension=[]){

    const tableDefinition = {
      name: "users", 
      columns: [
        {name: "name", type: "VARCHAR(255)"}, 
        {name: "email", type: "VARCHAR(512)", notnull: true, index: true, unique: true}, 
        {name: "passwordhash", type: "VARCHAR(512)", notnull: true},
        {name: "salt", type: "VARCHAR(512)", notnull: true},
        {name: "lastlogin", type: "DATETIME", notnull: true, default: "CURRENT_TIMESTAMP"},
        {name: 'verified', type: 'BOOLEAN', notnull: true, default: false, datatype: 'boolean'},
        {name: 'creator', type: 'BIGINT'},
        {name: 'onetimelink', type: 'VARCHAR(512)'},
        {name: 'onetimelinkhash', type: 'VARCHAR(512)'},
        {name: 'onetimelinktimestamp', type: 'DATETIME', default: 'CURRENT_TIMESTAMP'},
        {name: "roles", type: "VARCHAR(512)", datatype: 'array'},
        {name: 'googleauthtoken', type: 'VARCHAR(512)', datatype: 'object'},
      ],
      foreignkeys: [
        {name: "fk_creator", column: "creator", reference: "users", refcolumn: "id", onupdate: "CASCADE", ondelete: "SET NULL"}
      ]
    };

    super({id, name, email, salt, verified, roles, deleted, googleauthtoken, googleauthrefreshtoken}, tableDefinition, runtimeExtension);
  }

  hashPassword(password){
    const len = 128
    , iterations = 12000
    , digest = "sha512"
    , saltType = 'user'
    ;

    return _deriveSalt.bind(this)(len, saltType)
    .then(derivePasswordHash.bind(this, password,iterations, len, digest))
    .catch((err)=> Promise.reject(err))
  }

  /*
   * create one time link for use in password reset or email verification
   * create a 32 digit salt (which is the one-time link) and use that to generate a hash of the request type 
   * ('email' or 'password'). This means that the one-time link is crytographically random and will only
   * validate against its own type i.e. you can't use an email verification on-time link to perform a password
   * change or vice versa
   *
   * @params {string} type - type of one-time link.  options are 'email' or 'password'
   *            option 'email' generates one time links for email verification
   *            option 'password' generates one time link for password resets
   * @params {bool} bypassSalt - flag to request bypassing salt creation if true
   * @params {int} linkExpiryTime - time period (in minutes) when link is valid
   * @api public
  */
  createOneTimeLink(type, bypassSalt, linkExpiryTime=10){

    const len = 32
    , iterations = 12000
    , digest = "sha512"
    ;
    
    if(bypassSalt){
      if(!this.onetimelink){return Promise.reject(new Error('onetimelink required'))}
      return deriveOneTimeLinkHash.bind(this)(type, iterations, len, digest, linkExpiryTime);
    } else {
      return _deriveSalt.bind(this)(len, type)
      .then(deriveOneTimeLinkHash.bind(this, type, iterations, len, digest, linkExpiryTime))      
    }

  }

  login(req){
    return new Promise((resolve, reject)=>{
      if(this.deleted){return reject(new Error('login: userr account inactive')); }
      if(!this.authenticated){return reject(new Error('login: user account needs to be authenticated prior to login')); }

      req.session.regenerate(()=>{
        req.session.user = this;
        // update last login
        this.lastlogin = new Date();
        this.save()
        .then(resolve)
        .catch(reject)
      })
    })
  }

  logout(req){
    return new Promise((resolve, reject)=>{
      const saveCurrentAlerts = req.session.alerts;  // save any existing alerts
      req.session.destroy((err)=>{
        if(err){return reject(new Error('logout: user session could not be destroyed - \n' + err.message)); }
        return resolve();
      })
    })
  }

  authenticate(password){
    let referenceUser = new User({id: this.id, email:this.email});
    return referenceUser.load()
    .then(()=>{
      this.salt = referenceUser.salt;
      return Promise.resolve();
    })
    .then(()=> this.hashPassword(password))
    .then(()=>{
      this.authenticated = this.passwordhash === referenceUser.passwordhash ? true : false;
      return this.authenticated ? Promise.resolve() : Promise.reject(new Error('password mismatch'));
    })
    .then(()=>{
      // update values of this
      referenceUser.tableDefinition.columns.forEach((column)=>{
        this[column.name] = referenceUser[column.name];
      })
      return Promise.resolve();
    })
    .catch((err)=> Promise.reject(new Error('user authentication failed - ' + err.message)));
  }


  /* 
   * send one-time link to user to enable password reset
   *
   * @params {string} userType - type of user the reset is being initiated for.  can be 'new' or 'existing'
   * @params {int} linkExpiryTime - time, in minutes, for link to be valid
   * @api public
  */
  initiatePasswordReset(userType='existing', linkExpiryTime=10){
    // create object to track completion of steps in order to select the correct error message
    let phaseCompleted = {
      load: false,
      createOneTimeLink: false,
      save: false,
      sendEmail: false
    };

    return this.load({email: this.email})
    .then(()=> {phaseCompleted.load = true; return Promise.resolve()})
    .then(()=> this.createOneTimeLink('password', false, linkExpiryTime))
    .then(()=> {phaseCompleted.createOneTimeLink = true; return Promise.resolve()})
    .then(()=> this.save())
    .then(()=> {phaseCompleted.save = true; return Promise.resolve()})
    .then(()=>{
      const from = system.systemGlobal.getConfig('siteEmail');
      const to = this.email;
      let subject;
      const oneTimeLink = system.systemGlobal.getConfig('siteURL') + '/handy/resetpassword/' + this.onetimelink + '?email=' + encodeURIComponent(this.email);
      let text;

      switch(userType){
        case 'new':
          subject = system.systemGlobal.getConfig('siteName') + ' - new account created  [Action required]';
          text = `Hi,<br><br>
            The administrator of ` + system.systemGlobal.getConfig('siteName') + ` has 
            created an account for you.<br><br>
            
            Please <a href="` + oneTimeLink + `">click on this link</a> to set 
            your password and finish setting up your account<br><br>
            
            Alternatively, you can copy and paste the link below into 
            your browser:<br><br> ` + oneTimeLink + `<br><br>
            
            Please note that this link will expire in ` + Math.floor(linkExpiryTime / 60) + ` hours 
            after which it will no longer be usable and a new password reset request 
            will have to be made.<br><br>

            If you are not expecting this account, you can ignore this message
             and the account created will remain inactive<br><br>

            Regards<br><br>
            The ` + system.systemGlobal.getConfig('siteName') + ` team
          `;
          break;
        case 'existing':
        default:
          subject = system.systemGlobal.getConfig('siteName') + ' password reset instructions  [Action required]';
          text = `Hi,<br><br>
            We have received a request to reset your password 
            on ` + system.systemGlobal.getConfig('siteName') + `
            <br><br><a href='` + oneTimeLink + `'>Click here to reset 
            your password</a><br><br>

            Alternatively, you can copy and paste the link below into your 
            browser:<br><br>` + oneTimeLink + `<br><br>
            Please note that this link will expire in ` + linkExpiryTime + ` minutes 
            after which it will no longer be usable and a new password reset request 
            will have to be made.<br><br>

            If you did not make this request, you can ignore this message and no 
            changes will be made to your account.<br><br>

            Regards<br><br>
            The ` + system.systemGlobal.getConfig('siteName') + ` team
          `;        
      }

      return system.createEmailQueueItem({from, to, subject, text})
    })
    .then(()=> {phaseCompleted.sendEmail = true; return Promise.resolve()})
    .catch((err)=>{
      let errorMessage;
      let errorFoundFlag = false;
      _.forEach(phaseCompleted, (status, phase)=>{
        if(!status && !errorFoundFlag){
          switch(phase){
            case 'load':
              errorMessage = 'user account not found - ' + err.message;
              errorFoundFlag = true;
              break;
            case 'createOneTimeLink':
              errorMessage = 'reset link could not be created - ' + err.message;
              errorFoundFlag = true;
              break;
            case 'save':
              errorMessage = 'reset link could not be saved to user account - ' + err.message;
              errorFoundFlag = true;
              break;
            case 'sendEmail':
              errorMessage = 'password reset instructions could not be sent by email - ' + err.message;
              errorFoundFlag = true;
              break;
            default:
          }
        }
      })
      return Promise.reject(new Error(errorMessage));
    })
  }
  
}

exports.User = User;

/* 
 * create salt for user object
 *
 * @params {int} len - length of generated salt
 * @params {string} saltType - type of salt (e.g. 'user', 'password', 'email')
 *         user - used to create this.salt; used for regular user authentication
 *         password - used to create this.onetimelink; used for password resets
 *         email - used to create this.onetimelink; used for email verification
 *
 * @api private
*/

function _deriveSalt(len, saltType='user'){
  return new Promise((resolve, reject)=>{
    const saltTarget = saltType === 'user' ? 'salt' : 'onetimelink';

    // stop processing if requesting this.salt when one already exists to avoid
    // making authentication of existing passwords impossible
    if(saltTarget === 'salt' && this[saltTarget]){return resolve();}
    crypto.randomBytes(len, (err, salt)=>{
      if(err){ return reject(err); }
      // uriencode salt if being used for one time link
      this[saltTarget] = saltTarget === 'salt' ? salt.toString("base64") : encodeURIComponent(salt.toString("base64"));
      return resolve();
    })
  })
}

// derive password hashes
function derivePasswordHash(password, iterations, len, digest){
  return new Promise((resolve, reject)=>{
    crypto.pbkdf2(password, this.salt, iterations, len, digest, (err, hash)=>{
      if(err){return reject(err); }
      this.passwordhash = (new Buffer(hash, "binary")).toString("base64");
      return resolve();
    })
  })
}

// derive hash of one-time link (necessary to distinguish types of one-time links)
function deriveOneTimeLinkHash(type, iterations, len, digest, linkExpiryTime){
  return new Promise((resolve, reject)=>{
    crypto.pbkdf2(type, this.onetimelink, iterations, len, digest, (err, hash)=>{
      if(err){return reject(err);}
      this.onetimelinkhash = (new Buffer(hash, 'binary')).toString('base64');
      this.onetimelinktimestamp = new Date(Date.now() + linkExpiryTime * 60 * 1000);
      return resolve();
    })
  })
}

/*
 * middleware to check if user is authenticated
 * can also be executed as a regular function where it returns true or false
 *
 * @param {object} req - express req object
 * @param {object} res - express res object
 * @param {function} next - express next function
 * @api public
 */
exports.isAuthenticated = isAuthenticated;

function isAuthenticated(req, res, next){
  const middleware = typeof next === 'undefined' ? false : true;

  const authenticated = !req.session || !req.session.user || !req.session.user.authenticated ? false : true;

  if(authenticated){
    return middleware ? next() : authenticated;
  } else {
    let error = new Error('user is not authenticated');
    error.code = 'UNAUTHENTICATEDUSER';
    return middleware ? next(error) : authenticated;
  }
}


/*
 * middleware to check is a user is an admin i.e. has role 'admin'
 *
 * @param {object} req - express req object
 * @param {object} res - express res object
 * @param {function} next - express next function
 * @api public
 */
exports.isAdmin = isAdmin;

function isAdmin(req, res, next){
  const adminRole = ['admin'];
  const user = req.session.user || {};
  if(hasRoles(user, adminRole)){
    return next();
  } else {
    let error = new Error('user does not have admin access rights');
    error.code = 'UNAUTHORISEDACCESS';
    return next(error);
  }
}


/*
 * function to check if user has one or more roles
 * checks if user has ALL the roles specified in arguments
 * 
 * @param {object} user - user who's roles are being verified
 * @param {string | array} roles - role (or array of roles) to be tested
 * @api public
 */
exports.hasRoles = hasRoles;

function hasRoles(user, roles){
  // check if roles is an array, if not make into an array
  roles = Array.isArray(roles) ? roles : [roles];
  let roleCtr = roles.length;

  roles.forEach((role)=>{
    if(user.roles.includes(role)){
      roleCtr--;  // decrement roleCtr for every role found in the user.roles array
    }
  })

  return roleCtr === 0 ? true : false;
}


/* 
 * initialize a google oauth2Client with the google account credentials
 *
 * @api public
 */
exports. generateGoogleOauth2Client = generateGoogleOauth2Client;

function generateGoogleOauth2Client(){
  const googleAuthRedirectURIPath = system.systemGlobal.getConfig('googleAuthRedirectURIPath');
  const siteURL = system.systemGlobal.getConfig('siteURL');
  const google_auth_redirect_url = siteURL + '/handy/' + googleAuthRedirectURIPath;
  const google_client_id = system.systemGlobal.getConfig('googleClientId');
  const google_client_secret = system.systemGlobal.getConfig('googleClientSecret');

  if(!google_client_id || !google_client_secret){
    return null;
  }

  const oauth2Client = new googleAuth.OAuth2Client(
    google_client_id,
    google_client_secret,
    google_auth_redirect_url
  );

  return oauth2Client;
}


/*
 * get google oauth redirection url
 *
 * @ api public
 */
exports.getGoogleOauthRedirectUrl = getGoogleOauthRedirectUrl;

function getGoogleOauthRedirectUrl(){
  const oauth2Client = generateGoogleOauth2Client();
  if(!oauth2Client){ return null; }

  let rawScopes = system.systemGlobal.getConfig('googleAuthScopes');
  rawScopes = rawScopes.split(',');
  let scopes = [];
  const scopeDefinition = {
    'readonly': 'https://www.googleapis.com/auth/gmail.readonly',
    'compose': 'https://www.googleapis.com/auth/gmail.compose',
    'send': 'https://www.googleapis.com/auth/gmail.send',
    'insert': 'https://www.googleapis.com/auth/gmail.insert',
    'labels': 'https://www.googleapis.com/auth/gmail.labels',
    'modify': 'https://www.googleapis.com/auth/gmail.modify',
    'metadata': 'https://www.googleapis.com/auth/gmail.metadata',
    'settings_basic': 'https://www.googleapis.com/auth/gmail.settings.basic',
    'settings_advanced': 'https://www.googleapis.com/auth/gmail.settings.sharing',
    'full': 'https://mail.google.com/'
  };

  rawScopes.forEach((rawScope)=>{
    rawScope = rawScope.trim();
    if(scopeDefinition[rawScope]){
      scopes.push(scopeDefinition[rawScope]);
    }
  })

  const oauthRedirectUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes
  })

  return oauthRedirectUrl;
}


/*
 * get Google auth tokens
 *
 * @param {string} code - string returned from Google auth call
 * @api public
 */
exports.getGoogleOauthTokens = getGoogleOauthTokens;

function getGoogleOauthTokens(code){
  return new Promise((resolve, reject)=>{
    if(!code){return reject(new Error('no Google auth code provided'))};

    const oauth2Client = generateGoogleOauth2Client();
    if(!oauth2Client){ return reject(new Error('Google API credentials likely missing')); }

    oauth2Client.getToken(code)
    .then((response)=> resolve(response.tokens))
    .catch(reject);
  })
}


/*
 * refresh Google auth tokens
 *
 * needs to be bound to either a user object or null
 * if null, assumes the system account is being used
 * @api public
 */
exports.refreshGoogleAuthTokens = refreshGoogleAuthTokens;

function refreshGoogleAuthTokens(){
  return new Promise((resolve, reject)=>{

    // get current tokens
    let currentToken
    , owner
    ;
    if(this instanceof User){
      currentToken = this.googleauthtoken;
      owner = 'user';
    } else {
      currentToken = system.systemGlobal.getConfig('siteGoogleAuthAccessToken');
      owner = 'system';
    }

    return resolve(currentToken);  // since google-auth-library v2.0.0, token refresh happens automatically

/*
    const oauth2Client = generateGoogleOauth2Client();
    if(!oauth2Client){ return reject(new Error('Google API credentials likely missing')); }

    // stop processing if tokens have not expired
    const now = Date.now();
    if(currentToken.expiry_date - now){return resolve(currentToken); }

    oauth2Client.setCredentials(currentToken);
    oauth2Client.refreshAccessToken()
    .then((response)=>{
      // save new tokens
      if(owner === 'system'){
        system.systemGlobal.updateConfig({siteGoogleAuthAccessToken: response.credentials})
        .then(()=> resolve(response.credentials))
        .catch(reject);
      } else {
        this.googleauthtoken = response.credentials;
        return this.save()
        .then(()=> resolve(response.credentials))
        .catch(reject);
      }
    })
*/
  })
}