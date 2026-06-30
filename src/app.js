require("dotenv-safe").config();
const cheerio = require("cheerio");
const sha1 = require("sha1");
const pLimit = require("p-limit");
const admin = require("firebase-admin");
const { cert, getApp, deleteApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const FBCONFIG = require("./fbconfig.js");
const { httpAgent, getData, withTimeout, getUrlParam } = require("./util.js");
const BASE_URL = "https://in2touch.spawtz.com";

// Disable excessive retries in Google Auth Library
process.env.GCLOUD_PROJECT = process.env.PROJECT_ID;
// Set gaxios (used by google-auth-library) to have minimal retries
process.env.GAXIOS_RETRY = "0"; // Disable automatic retries in gaxios
// Limit concurrent HTTP requests to avoid overwhelming the server
const limit = pLimit(5); // Max 5 concurrent requests

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
  const leagueIds = Object.keys(leagues);

  // Fetch all leagues in parallel with concurrency limit
  const results = await Promise.allSettled(
    leagueIds.map((l) =>
      limit(async () => {
        const html = await getData(leagues[l].standingUrl);
        if (!html) {
          console.log(
            `⚠️ Error getting data for ${leagues[l].name} ${leagues[l].id}`,
          );
          return null;
        }
        return { leagueId: l, html };
      }),
    ),
  );

  // Process results
  for (const result of results) {
    if (result.status === "rejected" || !result.value) continue;

    const { leagueId: l, html } = result.value;
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
        let num = 0;
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
  const teamIds = Object.keys(teamsData);

  // Fetch all team pages in parallel with concurrency limit
  const results = await Promise.allSettled(
    teamIds.map((t) =>
      limit(async () => {
        const html = await getData(teamsData[t].profileUrl);
        if (!html) {
          console.log(
            `⚠️ Error getting data for ${teamsData[t].name} ${teamsData[t].id}`,
          );
          return null;
        }
        return { teamId: t, html };
      }),
    ),
  );

  // Process results
  for (const result of results) {
    if (result.status === "rejected" || !result.value) continue;

    const { teamId: t, html } = result.value;
    const $ = cheerio.load(html);
    const lURL = BASE_URL + $(".BackLinks a").attr("href");
    const lID = `${getUrlParam(lURL, "LeagueId")}-${getUrlParam(lURL, "DivisionId")}`;
    const league = leagueList[lID];
    const leagueName = league ? league.name : false;

    const fixturesTable = $(".TFTable").first();
    teamsData[t].fixtures = [];
    teamsData[t].id = t;

    $(fixturesTable)
      .find(".TFRow")
      .each((i, row) => {
        const day = $(row).find(".TFDate").text();
        let time = $(row).find("td:nth-child(2)").text();

        // check for byes
        const isBye = time === "Bye";
        if (isBye) time = "18:00"; // there is no time for byes so set one

        if (day.length > 0) {
          teamsData[t].fixtures.push({
            type: isBye ? "bye" : "match",
            day,
            time: time,
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

const saveToFb = async (t, l, td) => {
  const db = getDatabase();

  console.log(`Saving ${Object.keys(t).length} teams...`);
  await Promise.all(
    Object.keys(t).map((id) =>
      limit(() => {
        const teamRef = db.ref("teams/" + id);
        return withTimeout(teamRef.set(t[id]));
      }),
    ),
  );

  console.log(`Saving ${Object.keys(td).length} team data...`);
  await Promise.all(
    Object.keys(td).map((id) =>
      limit(() => {
        const teamDataRef = db.ref("team-data/" + id);
        return withTimeout(teamDataRef.set(td[id]));
      }),
    ),
  );

  console.log(`Saving ${Object.keys(l).length} leagues...`);
  await Promise.all(
    Object.keys(l).map((id) =>
      limit(() => {
        const leaguesRef = db.ref("leagues/" + id);
        return withTimeout(leaguesRef.set(l[id]));
      }),
    ),
  );

  const configRef = db.ref("config");
  await withTimeout(
    configRef.set({
      updatedAt: Date.now(),
      teamsHash: sha1(JSON.stringify(t)),
      leaguesHash: sha1(JSON.stringify(l)),
      teamDataHash: sha1(JSON.stringify(td)),
    }),
  );
};

const init = async () => {
  console.log("Getting league list...");
  const leagueList = await getLeagues();
  console.log("Getting teams and leagues...");
  const { teams, leagues } = await getLeagueData(leagueList);
  let teamsData = JSON.parse(JSON.stringify(teams));
  console.log("Getting individual teams data...");
  teamsData = await getTeamData(teamsData, leagueList);

  console.log("Initializing Firebase...");
  // Wrap Firebase initialization with timeout to prevent hanging on auth
  await withTimeout(
    admin.initializeApp({
      credential: cert(FBCONFIG),
      databaseURL: process.env.DATABASE_URL,
      httpAgent,
    }),
    60000,
  );

  console.log("Saving to firebase...");
  await saveToFb(teams, leagues, teamsData);
  console.log("Closing connection to firebase...");
  await deleteApp(getApp());
  console.log("✅ All done!");
  process.exit(0);
};

// Run with 60-minute timeout (fail fast instead of retrying for hours)
withTimeout(init, 60 * 60 * 1000).catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
