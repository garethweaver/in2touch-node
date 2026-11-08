export interface LeagueTeam {
  name: string;
  id: string;
  profileUrl: string;
  played: number;
  won: number;
  lost: number;
  drawn: number;
  pointsFor: number;
  pointsAgainst: number;
  pointsBonus: number;
  points: number;
}

export interface League {
  name: string;
  id: string;
  nameLowercased: string;
  fixturesUrl: string;
  standingUrl: string;
  teams: LeagueTeam[];
}

export type Leagues = Record<string, League>;

export interface Team {
  name: string;
  nameLowercased: string;
  id: string;
  profileUrl: string;
}

export type Teams = Record<string, Team>;

export interface Fixture {
  type: "bye" | "match";
  day: string;
  time: string;
  timestamp: number;
  grading: boolean;
  pitch: string;
  leagueName: string | null;
  vs: string;
  vsId: string;
  result: string;
}

export interface TeamData extends Team {
  fixtures: Fixture[];
  fixturesHash: string;
}

export type TeamsData = Record<string, TeamData>;
