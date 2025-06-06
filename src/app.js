require("dotenv-safe").config();
const axios = require("axios");
const cheerio = require("cheerio");
const sha1 = require("sha1");
const admin = require("firebase-admin");
const FBCONFIG = require("./fbconfig.js");
const BASE_URL = "https://in2touch.spawtz.com";

const getData = async (url) => {
  try {
    console.info(`Requesting ${url}`);
    const response = await axios(url);
    return response.data;
  } catch (e) {
    if (e?.response) {
      console.error(
        "⚠️",
        e.response.status,
        e.response.statusText,
        e.config.url,
      );
    } else {
      comsole.error(e);
    }
    return null;
  }
};

const getUrlParam = (url, param) => {
  const u = new URL(url);
  return u.searchParams.get(param);
};

const getLeagueType = (leagueName) => {
  if (leagueName.toLowerCase().indexOf("mixed")) {
    return " [Mixed]";
  } else if (leagueName.toLowerCase().indexOf("men's")) {
    return " [Men's]";
  }
  return "";
};

const getLeagues = async () => {
  const l = {};
  const html = await getData(`${BASE_URL}/ActionController/LeagueList`);
  const $ = cheerio.load(html);

  $(".LTable tr").each((i, row) => {
    const fId = BASE_URL + $(row).find(".LFixtures").attr("href");
    const sId = BASE_URL + $(row).find(".LStandings").attr("href");
    const name = $(row)
      .find(".LTitle")
      .text()
      .trim()
      .replace(/\r|\t|\n/g, "");
    const id = `${getUrlParam(fId, "LeagueId")}-${getUrlParam(fId, "DivisionId")}`;

    l[`${id}`] = {
      name,
      id,
      nameLowercased: name.toLowerCase(),
      fixturesUrl: fId,
      standingUrl: sId,
      teams: [],
    };
  });

  return l;
};

const getLeagueData = async (leagues) => {
  const teams = {};

  for (const l in leagues) {
    const html = await getData(leagues[l].standingUrl);
    if (!html) {
      console.log(
        `⚠️ Error getting data for ${leagues[l].name} ${leagues[l].id}`,
      );
      continue;
    }
    const $ = cheerio.load(html);
    const leagueTableRows = $('.STTable tr[class^="STRow"]');

    leagueTableRows.each((i, row) => {
      const id = getUrlParam(
        BASE_URL + "/" + $(row).find(".STTeamCell a").attr("href"),
        "TeamId",
      );
      const name = $(row).find(".STTeamCell").text();
      const profileUrl = `${BASE_URL}${$(row).find(".STTeamCell a").attr("href")}`;

      leagues[l].teams.push({
        name,
        id,
        profileUrl,
        played: $(row).find("td:nth-child(3)").text(),
        won: $(row).find("td:nth-child(4)").text(),
        lost: $(row).find("td:nth-child(5)").text(),
        drawn: $(row).find("td:nth-child(6)").text(),
        pointsFor: $(row).find("td:nth-child(9)").text(),
        pointsAgainst: $(row).find("td:nth-child(10)").text(),
        pointsBonus: $(row).find("td:nth-child(12)").text(),
        points: $(row).find("td:nth-child(13) b").text(),
      });

      // there is a team entered into multiple leagues so create multiple db entries
      if (teams[id]) {
        const num = 0;
        // create an int for each new league
        while (teams[`${id}-${num}`]) num++;
        // try to work out if it's men's or mixed
        const appendToTeamName = getLeagueType(name);
        teams[`${id}-${num}`] = {
          name: `${name} ${num + 1}${appendToTeamName}`,
          nameLowercased: `${name} ${num + 1}${appendToTeamName}`.toLowerCase(),
          id: `${id}-${num}`,
          profileUrl,
        };
      } else {
        teams[id] = {
          name,
          nameLowercased: name.toLowerCase(),
          id,
          profileUrl,
        };
      }
    });
  }

  return {
    teams,
    leagues,
  };
};

const getTeamData = async (teamsData, leagueList) => {
  for (const t in teamsData) {
    const html = await getData(teamsData[t].profileUrl);
    if (!html) {
      console.log(
        `⚠️ Error getting data for ${teamsData[t].name} ${teamsData[t].id}`,
      );
      continue;
    }
    const $ = cheerio.load(html);
    const lURL = BASE_URL + $(".BackLinks a").attr("href");
    const lID = `${getUrlParam(lURL, "LeagueId")}-${getUrlParam(lURL, "DivisionId")}`;
    const league = leagueList[lID];
    const leagueName = league ? league.name : false;

    const fixturesTable = $(".TFTable");
    teamsData[t].fixtures = [];
    teamsData[t].id = t;

    $(fixturesTable)
      .find(".TFRow")
      .each((i, row) => {
        const day = $(row).find(".TFDate").text();
        const time = $(row).find("td:nth-child(2)").text();
        if (day.length > 0) {
          teamsData[t].fixtures.push({
            day,
            time,
            timestamp: new Date(`${day} ${time}`).getTime(),
            grading: $(row).prev().text().indexOf("Grading") > -1,
            pitch: $(row).find("td:nth-child(3)").text(),
            leagueName: leagueName,
            vs: $(row).find("td:nth-child(4)").text(),
            vsId: getUrlParam(
              BASE_URL + "/" + $(row).find("td:nth-child(4) a").attr("href"),
              "TeamId",
            ),
            result: $(row).find("td:nth-child(5)").text(),
          });
        }
      });

    teamsData[t].fixturesHash = sha1(JSON.stringify(teamsData[t].fixtures));
  }

  return teamsData;
};

const saveToFb = async (app, t, l, td) => {
  console.log(`Saving ${Object.keys(t).length} teams...`);
  for (id in t) {
    const teamRef = app.database().ref("teams/" + id);
    await teamRef.set(t[id]);
  }

  console.log(`Saving ${Object.keys(td).length} team data...`);
  for (id in td) {
    const teamDataRef = app.database().ref("team-data/" + id);
    await teamDataRef.set(td[id]);
  }

  console.log(`Saving ${Object.keys(l).length} leagues...`);
  for (id in l) {
    const leaguesRef = app.database().ref("leagues/" + id);
    await leaguesRef.set(l[id]);
  }

  const configRef = app.database().ref("config");
  await configRef.set({
    updatedAt: Date.now(),
    teamsHash: sha1(JSON.stringify(t)),
    leaguesHash: sha1(JSON.stringify(l)),
    teamDataHash: sha1(JSON.stringify(td)),
  });
};

const init = async () => {
  console.log("Getting league list...");
  const leagueList = await getLeagues();
  console.log("Geting teams and leagues...");
  const { teams, leagues } = await getLeagueData(leagueList);
  let teamsData = JSON.parse(JSON.stringify(teams));
  console.log("Geting individual teams data...");
  teamsData = await getTeamData(teamsData, leagueList);

  const app = admin.initializeApp({
    credential: admin.credential.cert(FBCONFIG),
    databaseURL: "https://in2touch-cc0ab.firebaseio.com",
  });

  console.log("Saving to firebase...");
  await saveToFb(app, teams, leagues, teamsData);
  console.log("Closing connection to firebase...");
  await app.delete();
  console.log("✅ All done!");
};

init();
