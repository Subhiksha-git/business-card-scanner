// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBEv1PnkBrPiwy3biRWD0-w1pKIkqdPQd4",
  authDomain: "business-card-scanner-cae7c.firebaseapp.com",
  projectId: "business-card-scanner-cae7c",
  storageBucket: "business-card-scanner-cae7c.firebasestorage.app",
  messagingSenderId: "1076949807724",
  appId: "1:1076949807724:web:1e8ebf0b756ba23b485e49",
  measurementId: "G-JVC18GQVPF"
};

// Initialize Firebase

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export {db};