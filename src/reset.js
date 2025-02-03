require("dotenv-safe").config();
const FBCONFIG = require("./fbconfig.js");
const admin = require("firebase-admin");

const app = admin.initializeApp({
  credential: admin.credential.cert(FBCONFIG),
  databaseURL: "https://in2touch-cc0ab.firebaseio.com",
});

const init = async () => {
  console.log("Removing teams");
  const teamRef = app.database().ref("teams/");
  await teamRef.remove();

  console.log("Removing team-data");
  const teamDataRef = app.database().ref("team-data/");
  await teamDataRef.remove();

  console.log("Removing leagues");
  const leaguesRef = app.database().ref("leagues/");
  await leaguesRef.remove();

  console.log("Removing config");
  const configRef = app.database().ref("config");
  await configRef.remove();

  console.log("All done!");
};

init();
