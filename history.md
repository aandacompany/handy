# History

## v 6.2.14
- modified CDN settings to set cache type and store type

## v 6.2.13
- upgraded build components
- modified CDN settings to allow setting expiry age

## v 6.2.12
- modified system/createDatabaseTables to limit the size of indexes when the size is too large

## v 6.2.11
- added system.sendStream to enable sending data responses in streams

## v 6.2.10
- fixed bug in system.chooseIdentifier which selected the wrong identifier when the value was null

## v 6.2.9
- fixed bug in getting error message when system.sendEmail fails 

## v 6.2.8
- fixed bug in system.chooseIdentifier which prevented loading objects by an identifier with a falsy value

## v 6.2.7
- log route returns error stack trace instead of JSON stringifying error (which is useless)

## v 6.2.6
- set system.getQueueItems to default to only returning unlocked taskqueue items

## v 6.2.4
- modified system.getQueueItems to be able to return only unlocked taskqueue items

## v 6.2.3
- upgraded csurf to support SameSite None and secure mode

## v 6.2.2
- modified session configuration to set cookies with SameSite None and secure mode if required

## v 6.2.1
- upgraded expressjs dependencies

## v 6.2.0
- added ability to create and destroy temporary database connection pools

## v 6.1.4
- decreased maximum number of connections in pool to 50

## v 6.1.3
- increased maximum number of connections in pool to 100

## v 6.1.2
- add utility function to round to decimal places

## v 6.1.1
- fixed bug in CDN seting for various paths which crashed the thread when accessed
- added CDN headers to various paths where they were missing

## v 6.1.0
- extended BaseObject to be able to find records based on provided identifiers

## v 6.0.5
- modified BaseObject constructor to enable dynamic modification of tableDefinition at runtime

## v 6.0.4
- bug fixes

## v 6.0.3
- added CDN caching control 

## v 4.0.2 // 07/09/17
---
Redesigned as proper NPM module

## v 4.0.0 // 05/08/17
---
Full rewrite of Handyjs
Rearchitected as node module