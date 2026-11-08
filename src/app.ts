import FBCONFIG from "./fbconfig.ts";
import * as cheerio from "cheerio";
import sha1 from "sha1";
import { initializeApp, cert, getApp, deleteApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import {
  httpAgent,
  getData,
  withTimeout,
  getUrlParam,
  fetchInParallel,
  limit,
} from "./util.ts";
import type { Fixture, Leagues, Teams, TeamData, TeamsData } from "./types.ts";

const BASE_URL = "https://in2touch.spawtz.com";

// Disable excessive retries in Google Auth Library
process.env.GCLOUD_PROJECT = process.env.PROJECT_ID;
// Set gaxios (used by google-auth-library) to have minimal retries
process.env.GAXIOS_RETRY = "0"; // Disable automatic retries in gaxios

const getLeagueType = (leagueName: string): string => {
  // normalise curly apostrophes so "Men’s" matches "men's"
  const name = leagueName.toLowerCase().replace(/[\u2018\u2019]/g, "'");
  if (/\bmixed\b/.test(name)) return " [Mixed]";
  // check women's before men's; \bmen won't match inside "women"
  if (/\b(women'?s|ladies)\b/.test(name)) return " [Women's]";
  if (/\bmen'?s\b/.test(name)) return " [Men's]";
  return "";
};

const getLeagues = async (): Promise<Leagues> => {
  const l: Leagues = {};
  const html = await getData(`${BASE_URL}/ActionController/LeagueList`);
  const $ = cheerio.load(html ?? "");

  $(".LTable tr").each((i, row) => {
    const fId = BASE_URL + $(row).find(".LFixtures").attr("href");
    const sId = BASE_URL + $(row).find(".LStandings").attr("href");
    const name = $(row)
      .find(".LTitle")
      .text()
      .trim()
      .replace(/\r|\t|\n/g, "");
    const id = `${getUrlParam(fId, "LeagueId")}-${getUrlParam(fId, "DivisionId")}`;

    l[id] = {
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

const getLeagueData = async (
  leagues: Leagues,
): Promise<{ teams: Teams; leagues: Leagues }> => {
  const teams: Teams = {};
  const leagueIds = Object.keys(leagues);

  // Fetch all leagues in parallel with concurrency limit
  const results = await fetchInParallel(leagueIds, async (l) => {
    const html = await getData(leagues[l].standingUrl);
    if (!html) {
      console.log(
        `⚠️ Error getting data for ${leagues[l].name} ${leagues[l].id}`,
      );
      return null;
    }
    return { leagueId: l, html };
  });

  // Process results
  for (const result of results) {
    const { leagueId: l, html } = result;
    const $ = cheerio.load(html);
    const leagueTableRows = $('.STTable tr[class^="STRow"]');

    leagueTableRows.each((i, row) => {
      const id = getUrlParam(
        BASE_URL + "/" + $(row).find(".STTeamCell a").attr("href"),
        "TeamId",
      );
      const key = `${id}`;
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
      if (teams[key]) {
        let num = 0;
        // create an int for each new league
        while (teams[`${key}-${num}`]) num++;
        // try to work out if it's men's or mixed
        const appendToTeamName = getLeagueType(leagues[l].name);
        teams[`${key}-${num}`] = {
          name: `${name} ${num + 1}${appendToTeamName}`,
          nameLowercased: `${name} ${num + 1}${appendToTeamName}`.toLowerCase(),
          id: `${key}-${num}`,
          profileUrl,
        };
      } else {
        teams[key] = {
          name,
          nameLowercased: name.toLowerCase(),
          id: key,
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

const getTeamData = async (
  teams: Teams,
  leagueList: Leagues,
): Promise<TeamsData> => {
  // Deep clone so the original teams object isn't mutated
  const teamsData = JSON.parse(JSON.stringify(teams)) as TeamsData;
  const teamIds = Object.keys(teamsData);

  // Fetch all team pages in parallel with concurrency limit
  const results = await fetchInParallel(teamIds, async (t) => {
    const html = await getData(teamsData[t].profileUrl);
    if (!html) {
      console.log(
        `⚠️ Error getting data for ${teamsData[t].name} ${teamsData[t].id}`,
      );
      return null;
    }
    return { teamId: t, html };
  });

  // Process results
  for (const result of results) {
    const { teamId: t, html } = result;
    const $ = cheerio.load(html);
    const lURL = BASE_URL + $(".BackLinks a").attr("href");
    const lID = `${getUrlParam(lURL, "LeagueId")}-${getUrlParam(lURL, "DivisionId")}`;
    const league = leagueList[lID];
    const leagueName = league ? league.name : false;

    const fixturesTable = $(".TFTable").first();
    const team: TeamData = teamsData[t];
    const fixtures: Fixture[] = [];
    team.fixtures = fixtures;
    team.id = t;

    fixturesTable.find(".TFRow").each((i, row) => {
      const day = $(row).find(".TFDate").text();
      let time = $(row).find("td:nth-child(2)").text();

      // check for byes
      const isBye = time === "Bye";
      if (isBye) time = "18:00"; // there is no time for byes so set one

      if (day.length > 0) {
        fixtures.push({
          type: isBye ? "bye" : "match",
          day,
          time,
          timestamp: new Date(`${day} ${time}`).getTime(),
          grading: $(row).prev().text().indexOf("Grading") > -1,
          pitch: $(row).find("td:nth-child(3)").text(),
          leagueName,
          vs: $(row).find("td:nth-child(4)").text(),
          vsId: getUrlParam(
            BASE_URL + "/" + $(row).find("td:nth-child(4) a").attr("href"),
            "TeamId",
          ),
          result: $(row).find("td:nth-child(5)").text(),
        });
      }
    });

    team.fixturesHash = sha1(JSON.stringify(fixtures));
  }

  return teamsData;
};

const saveCollection = async (path: string, items: Record<string, unknown>) => {
  const db = getDatabase();
  await Promise.all(
    Object.keys(items).map((id) =>
      limit(() => withTimeout(db.ref(`${path}/${id}`).set(items[id]))),
    ),
  );
};

const saveToFb = async (t: Teams, l: Leagues, td: TeamsData) => {
  console.log(`Saving ${Object.keys(t).length} teams...`);
  await saveCollection("teams", t);

  console.log(`Saving ${Object.keys(td).length} team data...`);
  await saveCollection("team-data", td);

  console.log(`Saving ${Object.keys(l).length} leagues...`);
  await saveCollection("leagues", l);

  const configRef = getDatabase().ref("config");
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
  console.log("Getting individual teams data...");
  const teamsData = await getTeamData(teams, leagueList);

  console.log("Initializing Firebase...");
  initializeApp({
    credential: cert(FBCONFIG),
    databaseURL: process.env.DATABASE_URL,
    httpAgent,
  });

  console.log("Saving to firebase...");
  await saveToFb(teams, leagues, teamsData);
  console.log("Closing connection to firebase...");
  await deleteApp(getApp());
  console.log("✅ All done!");
  process.exit(0);
};

// Run with 60-minute timeout (fail fast instead of retrying for hours)
withTimeout(init, 60 * 60 * 1000).catch((error: unknown) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
