import * as cluster from 'cluster';

if (cluster.isMaster) {
    require('./Master');
} else {
    require('./Worker');
}
