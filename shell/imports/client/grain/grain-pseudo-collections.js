import { Mongo } from "meteor/mongo";

export const TokenInfo = new Mongo.Collection("tokenInfo");
export const GrantedAccessRequests = new Mongo.Collection("grantedAccessRequests");
export const GrainLog = new Mongo.Collection("grainLog");
