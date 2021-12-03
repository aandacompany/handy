(()=>{
  // set focus on the tab based on query parameter 'tab' in url
  window.addEventListener('load', ()=>{
    let queryParams = {};
    let temp = {}; // temporary variable to hold query
    const tabId = window.location.search.slice(1).split('&');  // get query string and remove initial '&'
    
    //- update queryParams with the query string values
    tabId.forEach((item)=>{
      temp = item.split('=');
      queryParams[temp[0]] = temp[1];
    });

    if(queryParams.tab){
      const activeTab = $('#tab-headers a[href="#' + queryParams.tab + '"]' );
      if(activeTab){activeTab.tab('show')}
    }
  })


  /* change selection of email agent radio buttons */

  // set event listeners on encapsulating links
  let listLinks = document.getElementsByClassName('email_agent');
  for(let i=0; i<listLinks.length; i++){
    listLinks[i].addEventListener('click', handleListLinkClick);
  }

  // check selected radio input
  function handleListLinkClick(e) {
    // find child radio input
    let childRadio = e.currentTarget.querySelector('input[name="emailAgent"]');
    if(childRadio){
      childRadio.checked = true;
    } 
  }

})()

    