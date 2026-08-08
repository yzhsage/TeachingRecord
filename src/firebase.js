import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth } from "firebase/auth";

// This apiKey is not a secret — Firebase web apps always ship it in
// client code. The actual security boundary is the Realtime Database
// rules (see firebase.rules.json) plus the login gate in AuthGate.jsx.
const firebaseConfig = {
  apiKey: "AIzaSyBQvAPRyCOLtrsSZd-aHztxm1EGMwsVBf4",
  authDomain: "teaching-record.firebaseapp.com",
  databaseURL: "https://teaching-record-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "teaching-record",
  storageBucket: "teaching-record.firebasestorage.app",
  messagingSenderId: "121986078491",
  appId: "1:121986078491:web:3e64aafac2e5b08575a5be",
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);
