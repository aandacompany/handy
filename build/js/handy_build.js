(()=>{
  'use strict';

  // manages view '/handy/logs/view'
  const logviewer = {
    logRecords: [],
    filters: [],

    initialize: ()=>{
      logviewer.setEventListeners();
      logviewer.getLogRecords();
    },

    setEventListeners: ()=>{
      // submit button
      document.getElementById('date_filter').addEventListener('submit', logviewer.handleSubmit);
      let filters = document.getElementsByClassName('select_filter');
      for(let i=0; i<filters.length; i++){
        filters[i].addEventListener('input', logviewer.filterLogDisplay);
      }
    },

    setProgressBar: (state)=>{
      // display progress bar when state is true, hide when false
      const progressBar = document.getElementById('progress_bar');
      switch(state){
        case true:
          progressBar.classList.remove('hidden');
          break;
        case false:
          progressBar.classList.add('hidden');
          break;
      }
    },

    displayLogs: ({logs=[], err})=>{
      logviewer.setProgressBar(false);
      let resultsDisplay = document.getElementById('log_records');

      if(err){
        resultsDisplay.innerHTML = '<p>error displaying log records<br>' + JSON.stringify(err) + '</p>';
      } else {
        if(!logs.length){
          resultsDisplay.innerHTML = '<p>No log records found</p>'
        } else {
          resultsDisplay.innerHTML = '<pre>' + JSON.stringify(logs, null, 2) + '</pre>';
        }
      }
    },

    getLogRecords: (age=1)=>{
      logviewer.setProgressBar(true);
      let request = new XMLHttpRequest();
      const method = 'GET';
      const destination = '/handy/logs/json' + '/' + age;
      request.open(method, destination);
      request.send();
      request.onreadystatechange = ()=>{
        if(request.readyState === XMLHttpRequest.DONE){
          try{
            let response = JSON.parse(request.responseText);
            let {logs, filters} = response;
            logviewer.displayLogs(response);
            logviewer.logRecords = logs;
            logviewer.filters = filters;

            // set up filter values
            filters.forEach((filter)=>{
              let select = document.getElementById(filter.id);
              // remove all options (that are not all from select
              for(let i=0; i<select.length; i++){
                if(typeof select.options[i] !== 'undefined' && select.options[i].value !== 'all'){
                  select.remove(i); // remove option
                  i--;  // decrement counter
                }
              }

              // add new select options
              filter.values.forEach((value)=>{
                if(value !== null && value !== ''){
                  let option = document.createElement('option');
                  option.value = value;
                  option.innerHTML = value;
                  select.appendChild(option);
                }
              })
            })
          }
          catch(err){
            logviewer.displayLogs({err});
          }

        }
      }
    },

    handleSubmit: (e)=>{
      e.preventDefault();

      // get form values
      const time = document.getElementById('time').value;
      logviewer.getLogRecords(time);
    },

    filterLogDisplay: (e)=>{
      // get values of all filters
      let filters = document.getElementsByClassName('select_filter');
      let filteredRecords = logviewer.logRecords.slice();  // copy by value
      for(let i=0; i<filters.length; i++){
        const label = filters[i].dataset.label;
        const value = filters[i].value;
        let tempFilteredRecords = filteredRecords.filter((record)=>{
          let recordValue = _extractRecordValue(record, label, logviewer.filters);
          let flag = recordValue === _typeTransform(value, typeof recordValue) ? true : false;
          if(value === 'all'){
            flag = true;
          }
          return flag;
        })

        filteredRecords = tempFilteredRecords.slice();
      }

      logviewer.displayLogs({logs: filteredRecords})
    },
  }

  window['logviewer'] = logviewer;  // ensure name is preserved after minification

  // transform a given value to the specified type
  function _typeTransform(value, type){
    if(typeof value === type){return value; }  // stop processing if already there

    switch(type){
      case 'number':
        return Number.parseFloat(value);
        break;
      case 'integer':
        return Number.parseInt(value, 10);
        break;
      case 'string':
        return String(value);
        break;
      default:
        return value;
    }
  }

  // get the value of a given label from a record given a filter definition
  // label has format {id: <label>, values: <array of options for select>, definition: <string of properties matching structure of object 'record'}

  function _extractRecordValue(record={}, label='', filters=[]){
    // find definition for matching filter
    let matchingFilterDefinition = '';
    filters.forEach((filter)=>{
      if(label === filter.id){
        matchingFilterDefinition = filter.definition;
      }
    })

    matchingFilterDefinition = matchingFilterDefinition.split('.');  
    let recordValue = JSON.parse(JSON.stringify(record));  // clone record
    matchingFilterDefinition.forEach((prop)=>{
      recordValue = typeof recordValue !== 'undefined' ? recordValue[prop] : recordValue;
    })

    return recordValue;
  }
})();