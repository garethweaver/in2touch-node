import FBCONFIG from "./fbconfig.ts";
import { initializeApp, cert, getApp, deleteApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

initializeApp({
  credential: cert(FBCONFIG),
  databaseURL: process.env.DATABASE_URL,
});

const db = getDatabase();

const init = async () => {
  console.log("Removing teams");
  const teamRef = db.ref("teams/");
  await teamRef.remove();

  console.log("Removing team-data");
  const teamDataRef = db.ref("team-data/");
  await teamDataRef.remove();

  console.log("Removing leagues");
  const leaguesRef = db.ref("leagues/");
  await leaguesRef.remove();

  console.log("Removing config");
  const configRef = db.ref("config");
  await configRef.remove();

  console.log("Closing connection to firebase...");
  await deleteApp(getApp());

  console.log("✅ All done!");
  process.exit(0);
};

init().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});
