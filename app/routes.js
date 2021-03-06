var express = require('express')
var router = express.Router()
var data = require('./data.js')
var elasticsearch = require('elasticsearch')
var request = require('request');
var http = require('http');
var parse = require('csv-parse');
var sanitizeHtml = require('sanitize-html');
var moment = require('moment');



const esClient = new elasticsearch.Client({
  host: process.env.ES_HOST,
//  log: 'trace'
})

// Deliver all the data to every template
router.use(function(req,res,next){
  res.locals.data = data
  next()
})

// Route index page
router.get('/', function (req, res) {
  res.render('index')
})

router.use(function(req,res,next){
  res.locals.data = data
  next()
})



const monthNames =  {'01': 'January', '02': 'February', '03': 'March', '04': 'April', '05': 'May', '06': 'June', '07': 'July', '08': 'August', '09': 'September', '10': 'October', '11': 'November', '12': 'December'};
const processEsResponse = results =>
  results.hits.hits
    .map(result => {
      var newResult = result._source
      const day = newResult.last_updated_at.substr(8,2)
      const month = monthNames[newResult.last_updated_at.substr(5,2)]
      const year = newResult.last_updated_at.substr(0,4)
      const frequency = newResult.update_frequency || 'none'
      newResult.location = [ newResult.location1, newResult.location2, newResult.location3]
        .filter(loc => loc)
        .join(',')
      newResult.location = sanitize(newResult.location)
      newResult.title = sanitize(newResult.title)
      newResult.summary = sanitize(newResult.summary)
      newResult.notes = sanitize(newResult.notes)
      newResult.last_updated = day + ' ' + month + ' ' + year
      newResult.next_updated = updateDate(frequency, newResult.last_updated_at)
      return newResult
    })


// Calculates the expected update date, based on frequency selected and the last time the dataset
// was updated.

function updateDate(frequency, lastEditDate){

  var lastEditDate = moment(lastEditDate);
  var frequency = frequency.toLowerCase()
  var nextUpdated = ''

  function formatDate(date){
    return moment(date).format("DD MMMM YYYY")
  }

  switch(frequency) {
    case('annual'):
      date = moment(lastEditDate).add(1, 'years')
      nextUpdated = `${formatDate(date)}`
      break
    case('quarterly'):
      date = moment(lastEditDate).add(4, 'months')
      nextUpdated = `${formatDate(date)}`
      break
    case('monthly'):
      date = moment(lastEditDate).add(1, 'months')
      nextUpdated = `${formatDate(date)}`
      break
    case('daily'):
      date = moment(lastEditDate).add(4, 'days')
      nextUpdated = `${formatDate(date)}`
      break
    case('discontinued'):
      nextUpdated = 'Dataset no longer updated'
      break
    case('never'):
      nextUpdated = 'No future updates'
      break
    case('one off'):
      nextUpdated = 'No future updates'
      break
    default:
      nextUpdated = 'Not available'
  }
  return nextUpdated
}

function sanitize(text) {
  // This should work according to the documentation, but doesn't
  //  return sanitizeHtml(text, { allowedTags: [], parser: {decodeEntities: false} })
  return sanitizeHtml(text, { allowedTags: [] }).replace('&amp;', '&');

}


router.get('/search-results', function(req, res, next) {
  const query = req.query.q
  const location = req.query['location']
  const page = req.query.page || 1
  orgTypes = req.query['org-type'] || ''

  // Remove extraneous org-type=_unchecked that appears due to prototype-kit
  // issue.  We don't want it....
  if (orgTypes && Array.isArray(orgTypes)) {
    orgTypes = orgTypes.filter((item)=>{return item != '_unchecked'})
  }

  // Copy the query because we don't want to provide a potentially modified
  // version back to the template.
  var query_string = query || ""
  var sortBy = req.query['sortby']
  var limit = 10
  var offset = (page * limit) - limit

  // Remove punctuation from the query string
  query_string = query_string.replace(/\W/g, ' ')

  if (location) {
    query_string += " " + location
    query_string = query_string.trim()
  }

  // If there is no query string, we will default to showing the most recent
  // datasets as we can't have relevance when there is nothing to check
  // relevance against. At the same time, we want to match everything if the
  // user has provided no terms so we will search for *
  if (query_string == ""){
    if (!sortBy) sortBy = 'recent'
    query_string = "*"
  }

  // TODO: When we have an organisation_type to filter on, we will need to change
  // the query_string to append " organisation_type:X" where X is the short
  // name of the organisation. We don't yet have this info in the search index.


  var esQuery = {
    index: process.env.ES_INDEX,
    body: {
      query: {
        query_string: {
          query: query_string,
          fields: [
                   "summary^2", "title^3", "description^1",
                   "location1^2", "location2^2", "location3^2",
                   "_all"
                  ],
          default_operator: "and"
        }
      },
      from: offset,
      size: limit
    }
  }

  // Set the sort field if the user has selected one in the UI, otherwise
  // we will default to relevance (using _score).  We don't have popularity
  // scores yet, so we'll cheat and use the name of the dataset
  switch(sortBy) {
      case "recent":
          esQuery.sort = "last_updated_at:desc"
          break;
      case "viewed":
          esQuery.sort = "name:asc"
          break;
  }


  esClient.search(esQuery, (esError, esResponse) => {
    if (esError) {
      throw esError
    } else {

      var total_results = esResponse.hits.total
      var page_count = Math.ceil(total_results / 10)

      res.render('search-results', {
        central: orgTypes.indexOf('central-gov') !== -1,
        local: orgTypes.indexOf('local-auth') !== -1,
        bodies: orgTypes.indexOf('bodies') !== -1,
        query: query,
        orgTypes: orgTypes,
        sortBy: ['best', 'recent', 'viewed'].indexOf(sortBy) !== -1 ? sortBy : '',
        location: location,
        results: processEsResponse(esResponse),
        numResults: total_results,
        pageCount: page_count,
        currentPage: page
      })
    }
  })
})


/*
 * Return a collection of n datasets, similar to the one provided
 */
const get_more_like_this = (dataset, n) => {
  var like = dataset.title + " " +
             dataset.summary + " " +
             dataset.notes + " " +
             dataset.organisation_name;

  const esQuery = {
    index: process.env.ES_INDEX,
    body: {
      query: {
        more_like_this: {
          fields : ["title^3", "summary^3", "notes", "organisation_name^2"],
          like : like,
          min_term_freq : 4,
          max_query_terms : 12
        }
      }
    }
  }

  return new Promise((resolve, reject) => {
    esClient.search(esQuery, (esError, results) => {
      var matches = results.hits.hits
        .filter(item=>{
          return item._score > 0.65 && item._id != dataset.id
        })
        .map(item =>{
          return {
            name: item._source.name,
            title: sanitize(item._source.title),
            summary: sanitize(item._source.summary),
          }
        })
        .slice(0, n)
        resolve(matches)
    })
  })
}


function renderDataset(template, req, res, next) {
  const esQuery = {
    index: process.env.ES_INDEX,
    body: {
      query: { term: { name : req.params.name } }
    }
  }
  const backURL = req.header('Referer') || '/';

  esClient.search(esQuery, (esError, esResponse) => {
    var result = processEsResponse(esResponse)[0]
    const cmpStrings = (s1, s2) => s1 < s2 ? 1 : (s1 > s2 ? -1 : 0)

    const groupByDate = function(result){
      var groups = []
      result.datafiles.forEach(function(datafile){
        if (datafile['start_date']) {
          const yearArray = groups.filter(yearObj => yearObj.year == datafile['start_date'].substr(0,4))
          if (yearArray.length === 0) {
            var group = {'year': "", 'datafiles':[]}
            group['year']= datafile['start_date'].substr(0,4)
            group['datafiles'].push(datafile)
            groups.push(group)
          } else {
            yearArray[0]['datafiles'].push(datafile)
          }
        }
      })
      return groups
        .map(group=> {
          var newGroup = group
          newGroup.datafiles =
            group.datafiles.sort((g1, g2) => cmpStrings(g1.start_date, g2.start_date))
          return newGroup;
        })
        .sort((g1, g2) => cmpStrings(g1.year, g2.year))
    }

    if (esError || !result) {
      res.status(404).send('Not found');
    } else {
      result.title = sanitize(result.title)
      result.summary = sanitize(result.summary)
      result.notes = sanitize(result.notes)
      const location = [result.location1]
      if (result.location2) location.push(result.location2)
      if (result.location3) location.push(result.location3)
      result.location = sanitize(location.join(','))
      get_more_like_this(result, 3)
        .then( matches => {
          res.render(template, {
            result: result,
            related_datasets: matches,
            groups: groupByDate(result),
            back: backURL
          })
        })
     }
  })
}

router.get('/dataset/:name', function(req, res, next) { renderDataset('datasets/dataset', req, res, next); })
router.get('/dataset2/:name', function(req, res, next) { renderDataset('datasets/dataset2', req, res, next); })
router.get('/dataset3/:name', function(req, res, next) { renderDataset('datasets/dataset3', req, res, next); })
router.get('/dataset4/:name', function(req, res, next) { renderDataset('datasets/dataset4', req, res, next); })
router.get('/dataset5/:name', function(req, res, next) { renderDataset('datasets/dataset5', req, res, next); })



/* ========== Preview page ========== */

// On successfully fetching some data to preview, will render if to the template
const preview_success = (req, res, dataset_title, datalink, output, totalLines) => {
  res.render(
    'preview-1',
    {
      datasetName: req.params.datasetname,
      datasetTitle: sanitize(dataset_title),
      filename: datalink.name,
      url: datalink.url,
      previewData: output,
      previewHeadings: Object.keys(output[0]),
      lineCount: totalLines
    }
  )
}

// We might fail to fetch some data to preview, for a plethora of reasons
// and in this case we will fail gracefully
const preview_fail = (req, res, dataset_title, datalink, error) => {

  // Handle the possible missing datalink. Would be nicer if we had
  // if expressions ...
  var url = ''
  var filename = ''

  if (datalink) {
    url = datalink.url
    filename = datalink.name
  }

  res.render(
    'preview-1',
    {
      datasetName: req.params.datasetname,
      datasetTitle: sanitize(dataset_title),
      filename: filename,
      url: url,
      error: "We cannot show this preview as there is an error in the CSV data"
    }
  )
}

const getLineCount = (contentLength, fiveLineString) => {
   if (contentLength == -1) {
     return contentLength
   } else {
     oneLine = (fiveLineString.length) / 5
     return Math.floor(contentLength / oneLine)
   }
}

router.get('/preview-1/:datasetname/:datafileid', function (req, res) {
  // retrieve details for the datafile (URL, name)
  const esQuery = {
    index: process.env.ES_INDEX,
    body: {
      query: { term: { name : req.params.datasetname } }
    }
  }

  esClient.search(esQuery, (esError, esResponse) => {
    const datalink = esResponse.hits.hits[0]._source.datafiles
      .filter(l => l.id == req.params.datafileid)[0]
    const dataset_title = esResponse.hits.hits[0]._source.title

    datalink.format = datalink.format.toUpperCase();
    if (datalink && datalink.format === 'CSV') {
      const csvRequest = request.get(datalink.url);
      csvRequest
        .on('response', response => {
          if (response.headers['content-type'].toLowerCase().indexOf('csv') == -1) {
            preview_fail(req, res, dataset_title, datalink,
              "We cannot show a preview of this file as it isn't in CSV format"
            )
          }
          else {
            var str="";
            response.on('data', data => {
              str += data;
              var contentLength = Number(response.headers['content-length']) || -1
              // If we've got more than 10000 bytes

              if (str.length > Math.min(contentLength, 1000)) {
                str = str.split('\n').slice(0,6).join('\n');
                totalLines = getLineCount(contentLength, str)
                parse(str, { to: 5, columns: true }, (err, output) => {
                  if (err) {
                    preview_fail(req, res, dataset_title, datalink,
                      "We cannot show this preview as there is an error in the CSV data"
                    )
                  } else {
                    preview_success(req, res, dataset_title, datalink, output, totalLines)
                  }
                })
                csvRequest.abort();

              }
            })
          }
        })
        .on('error', error => {
          preview_fail(req, res, dataset_title, null,
            "We cannot show this preview as there is an error in the CSV data"
          )
        })
    } else {
      preview_fail(req, res, dataset_title, null,
        "We cannot show a preview of this file as it isn't in CSV format"
      )
    }
  })
})


module.exports = router
