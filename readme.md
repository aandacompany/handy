# Handyjs Documentation

## Introduction

## Features

## Dependencies

## Getting Started

## API Documentation

### Module - System

#### sendStream
Send responses in data streams

_arguments_
*  @params {function} func - function that returns data on event 'data'; ends with event 'end' and generates errors with event 'error'
* @params {string} delimiter - string that is sent to indicate distinct data chuncks ie data1-delimiter-data2-...  It should be a string that is unlikely to occur in the data chuncks and should not include repeating patterns
* @params {object} res - express response object

_example_
```js
app.get('/path', (req, res)=>{
  const streamFunction = ()=>{ / function that sends data on events}
  const delimiter = '#$%&*()-+=!@~';
  sendStream(streamFunction, delimiter, res)
  .then(()=> / end processing /)
  .catch((err)=> / eror processing /)
})
```

#### setCDNHeaders
Set cache control headers when CDN is in use

_arguments_
* @params {object} res - Express response object
* @params {int} age - Maximum caching time (in seconds)
* @params {string} cacheType - Type of caching allowed (default "private")
* @params {string} storeType - Type of storage allowd (default "no-store")

_example_
```js
app.get('/path', (req, res)=>{
  setCDNHeaders(res, 7200, 'public', '');
  res.send({response: 'ok'});  // the response to this request will be cached by the CDN and browsers for 2 hours
})

```


## How handyjs works

## License

## Credits