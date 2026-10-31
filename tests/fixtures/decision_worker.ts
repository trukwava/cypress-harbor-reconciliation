import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {decideMatch} from '../../src/domain';

// Each worker has a separate SQLite connection and its own event loop.
// Both wait for the test's signal before competing to decide the same match.
const db=new DatabaseSync(workerData.filename);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
parentPort?.postMessage({ready:true});
parentPort?.once('message',()=>{
  try {
    const result=decideMatch(db,workerData.candidateId,'accepted',
      'Independent reviewer decision',workerData.amount,workerData.org,workerData.actor);
    parentPort?.postMessage({ok:true,result});
  } catch(error) {
    parentPort?.postMessage({ok:false,error:String((error as Error)?.message||error)});
  } finally {
    db.close();
  }
});
