const axios = require('axios')
const cheerio = require('cheerio')
const sha1 = require('sha1')
const admin = require('firebase-admin')
const FBCONFIG = require('./fbconfig.js')
const BASE_URL = 'http://in2touch.spawtz.com'

const getData = async url => {
  try {
    const response = await axios(url)
    return response.data
  } catch (e) {
    console.error(e)
  }
}

const getUrlParam = (url, param) => {
  let u = new URL(url)
  return u.searchParams.get(param)
}

const getLeagues = async () => {
  let l = {}
  let html = await getData(`${BASE_URL}/ActionController/LeagueList`)
  let $ = cheerio.load(html)

  $('.LTable tr').each((i, row) => {
    let fId = BASE_URL + $(row).find('.LFixtures').attr('href')
    let sId = BASE_URL + $(row).find('.LStandings').attr('href')
    let name = $(row).find('.LTitle').text().trim().replace(/\r|\t|\n/g, '')
    let id = `${getUrlParam(fId, 'LeagueId')}-${getUrlParam(fId, 'DivisionId')}`

    l[`${id}`] = {
      name: name,
      id: id,
      nameLowercased: name.toLowerCase(),
      fixturesUrl: fId,
      standingUrl: sId,
      teams: [],
    }
  })

  return l
}

const getLeagueData = async leagues => {
  let teams = {}

  for (let l in leagues) {
    let html = await getData(leagues[l].standingUrl)
    let $ = cheerio.load(html)
    let leagueTableRows = $('.STTable tr[class^="STRow"]')

    leagueTableRows.each((i, row) => {
      let id = getUrlParam(BASE_URL + '/' + $(row).find('.STTeamCell a').attr('href'), 'TeamId')
      let name = $(row).find('.STTeamCell').text()
      let profile = `${BASE_URL}/External/Fixtures/TeamProfile.aspx?TeamId=${id}`

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
          nameLowercased: name.toLowerCase(),
          id: id,
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

const getTeamData = async (teamsData, leagueList) => {
  for (let t in teamsData) {
    let html = await getData(teamsData[t].profileUrl)
    let $ = cheerio.load(html)
    let lURL = BASE_URL + $('.BackLinks a').attr('href')
    let lID = `${getUrlParam(lURL, 'LeagueId')}-${getUrlParam(lURL, 'DivisionId')}`
    let league = leagueList[lID]
    let leagueName = league ? league.name : false

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
            grading: $(row).prev().text().indexOf('Grading') > -1,
            pitch: $(row).find('td:nth-child(3)').text(),
            leagueName: leagueName,
            vs: $(row).find('td:nth-child(4)').text(),
            vsId: getUrlParam(BASE_URL + '/' + $(row).find('td:nth-child(4) a').attr('href'), 'TeamId'),
            result: $(row).find('td:nth-child(5)').text(),
          }
        )
      }
    })

   teamsData[t].fixturesHash = sha1(JSON.stringify(teamsData[t].fixtures))
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
  let leagueList = await getLeagues()
  let { teams, leagues } = await getLeagueData(leagueList)
  let teamsData = JSON.parse(JSON.stringify(teams))
  teamsData = await getTeamData(teamsData, leagueList)

  const app = admin.initializeApp({
    credential: admin.credential.cert(FBCONFIG),
    databaseURL: 'https://in2touch-cc0ab.firebaseio.com'
  })

  await saveToFb(app, teams, leagues, teamsData)
  await app.delete()
  console.log('all done')
}

init()
