# Backlog

## Development
* Priority to implement User and System functionality (Content will follow)

## Documentation
* Route '/handy-ncsrf' has no CSRF protection.  Use for any incoming POST requests from other services e.g. webhooks
* Given the new architecture of handy 4.0, handy.initialize, the initialization function for handy, must be initiated before the routes declaration of the parent app.  This is unlike previous versions of handy where handy.initialize should be executed inside the http.server callback

* handy.addInstallFunctions - add functions (promises) that are executed post installation of handyjs.  Useful for creating database tables specific to the parent app

*  handy.addViews - enables apps built on handy to specify where additional views are located

## Warning


## Status
* create basic form field verification
  * apply to install form
* verify handyjs works
* start (shandy) handy-shopify module