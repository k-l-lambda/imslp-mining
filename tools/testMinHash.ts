
import { Minhash, LshIndex } from "minhash";
 
const s1 = ["minhash", "is", "a", "probabilistic", "data", "structure", "for", "estimating", "the", "similarity", "between", "datasets"];
const s2 = ["minhash", "is", "a", "probability", "data", "structure", "for", "estimating", "the", "similarity", "between", "documents"];
const s3 = ["cats", "are", "tall", "and", "have", "been", "known", "to", "sing", "a", "quite", "loudly"];
 
// generate a hash for each list of words
const m1 = new Minhash();
const m2 = new Minhash();
const m3 = new Minhash();
 
// update each hash
s1.forEach(w => m1.update(w));
s2.forEach(w => m2.update(w));
s3.forEach(w => m3.update(w));

//console.log("m1:", m1);

console.log("m1 jac m2:", m1.jaccard(m2));
console.log("m2 jac m1:", m2.jaccard(m1));
 
// add each document to a Locality Sensitive Hashing index
const index = new LshIndex({bandSize: 4});
index.insert("m1", m1);
index.insert("m2", m2);
index.insert("m3", m3);

console.log("index:", index.index);

// query for documents that appear similar to a query document
const matches = index.query(m1);
console.log("query m1:", matches);

//const bands = index.getHashbands(m1);
//console.log("bands:", bands);
