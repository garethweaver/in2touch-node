const axios = require('axios')
const cheerio = require('cheerio')
const firebase = require('firebase/app')
const sha1 = require('sha1')
require('firebase/database')
const FBCONFIG = require('./fbconfig.js')

const baseURL = 'http://in2touch.spawtz.com'

const getData = async url => {
  const response = await axios(url)
  return response.data
}

const getUrlParam = (url, param) => {
  let u = new URL(url)
  return u.searchParams.get(param)
}

const getLeagues = async venues => {
  let l = {}
  for (let url of venues) {
    let html = await getData(url)
    let $ = cheerio.load(html)
    let rows = $('.LTable tr')

    rows.each((i, row) => {
      let fId = baseURL + $(row).find('.LFixtures').attr('href')
      let sId = baseURL + $(row).find('.LStandings').attr('href')

      l[`${getUrlParam(fId, 'LeagueId')}-${getUrlParam(fId, 'DivisionId')}`] = {
        name: $(row).find('.LTitle').text().trim(),
        fixturesUrl: fId,
        standingUrl: sId,
        teams: [],
      }
    })
  }
  return l
}

const getLeagueData = async leagues => {
  let teams = {}

  for (let l in leagues) {
    let html = await getData(leagues[l].standingUrl)
    let $ = cheerio.load(html)
    let leagueTableRows = $('.STTable .STRow:not(first-child)')

    leagueTableRows.each((i, row) => {
      let id = getUrlParam(baseURL + '/' + $(row).find('.STTeamCell a').attr('href'), 'TeamId')
      let name = $(row).find('.STTeamCell').text()
      let profile = `${baseURL}/External/Fixtures/TeamProfile.aspx?TeamId=${id}`

      leagues[l].teams.push(
        {
          name: name,
          id: id,
          profileUrl: profile,
          played: $(row).find('td:nth-child(3)').text(),
          won: $(row).find('td:nth-child(4)').text(),
          lost: $(row).find('td:nth-child(5)').text(),
          drawn: $(row).find('td:nth-child(6)').text(),
          pointsFor: $(row).find('td:nth-child(9)').text(),
          pointsAgainst: $(row).find('td:nth-child(10)').text(),
          pointsBonus: $(row).find('td:nth-child(12)').text(),
          points: $(row).find('td:nth-child(13) b').text(),
        }
      )

      if (!teams[id]) {
        teams[id] = {
          name: name,
          profileUrl: profile,
        }
      }
    })
  }

  return {
    teams: teams,
    leagues: leagues,
  }
}

const getTeamData = async teamsData => {
  for (let t in teamsData) {
    let html = await getData(teamsData[t].profileUrl)
    let $ = cheerio.load(html)
    let fixturesTable = $('.TFTable')
    teamsData[t].fixtures = []
    teamsData[t].id = t

    $(fixturesTable).find('.TFRow').each((i, row) => {
      const day = $(row).find('.TFDate').text()
      const time = $(row).find('td:nth-child(2)').text()
      if (day.length > 0) {
        teamsData[t].fixtures.push(
          {
            day: day,
            time: time,
            timestamp: new Date(`${day} ${time}`).getTime(),
            pitch: $(row).find('td:nth-child(3)').text(),
            vs: $(row).find('td:nth-child(4)').text(),
            result: $(row).find('td:nth-child(5)').text(),
          }
        )
      }
    })
  }

  return teamsData
}


const saveToFb = async (app, t, l, td) => {
  for (id in t) {
    const teamRef = app.database().ref('teams/' + id)
    await teamRef.set(t[id])
  }

  for (id in td) {
    const teamDataRef = app.database().ref('team-data/' + id)
    await teamDataRef.set(td[id])
  }

  for (id in l) {
    const leaguesRef = app.database().ref('leagues/' + id)
    await leaguesRef.set(l[id])
  }

  const configRef = app.database().ref('config')
  await configRef.set({
    updatedAt: Date.now(),
    teamsHash: sha1(JSON.stringify(t)),
    leaguesHash: sha1(JSON.stringify(l)),
    teamDataHash: sha1(JSON.stringify(td)),
  })
}

const init = async () => {

  const venues = [
    `${baseURL}/ActionController/LeagueList?VenueId=5`,
    `${baseURL}/ActionController/LeagueList?VenueId=72`,
    `${baseURL}/ActionController/LeagueList?VenueId=8`,
    `${baseURL}/ActionController/LeagueList?VenueId=24`,
  ]

  let leagueList = await getLeagues(venues)
  let { teams, leagues } = await getLeagueData(leagueList)
  let teamsData = JSON.parse(JSON.stringify(teams));
  teamsData = await getTeamData(teamsData)

  const app = firebase.initializeApp(FBCONFIG)
  await saveToFb(app, teams, leagues, teamsData)
  await app.delete()
  console.log('all done')
}

init()
