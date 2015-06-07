// CAST-CENTRAL-SERVICE
// --------------------

var cluster     = require('cluster'),
    ipc         = require('node-ipc'),
    debug       = require('debug')('cast-central-service'),
    chromecast  = require('../lib/casts/chromecast.js'),
    castCentral = require('../index.js');

// The core service layer that directly 
// interfaces with cast devices.  
// Communication with this is only through 
// the IPC stack.

raw_workers = {};
workers = {};

ipc.config.silent = true;
ipc.config.socketRoot = '/tmp/';
ipc.config.appspace = 'cast-central.core';

if(cluster.isMaster){
    ipc.config.id = '-master';

    ipc.serve(function(){
        ipc.server.on('message', function(data, socket){
            switch(data.action){
            case 'new':
                debug('creating new resource', data, socket);
                var child = cluster.fork([]);
                raw_workers[child.id] = child;

                child.on('message', function(msg){
                    debug('master received message from worker', msg);
                    if(msg.alive){
                        workers[msg.id] = {
                            id: msg.id,
                            cast: msg.cast
                        };
                    }else{
                        delete workers[msg.id];
                        delete raw_workers[msg.id];
                    }
                });

                debug('spawned child id is', child.id);
                ipc.server.emit(socket, 'message', {'id': child.id});
                break;
            case 'delete':
                debug('deleting', data.options.id);
                if(raw_workers[data.options.id]){
                    raw_workers[data.options.id].kill();
                }

                delete workers[data.options.id];
                delete raw_workers[data.options.id];
                ipc.server.emit(socket, 'message', 'done');
                break;
            case 'list':
                debug('listing all resources');
                ipc.server.emit(socket, 'message', jsonWorkers(raw_workers));
                break;
            default:
                debug('unknown action:', data.action);
                ipc.server.emit(socket, 'message', 'unknown action');
            }
        });
    });

    debug('starting ipc server');
    ipc.server.start();
}else if(cluster.isWorker){
    debug('child-', cluster.worker.id, ' started');
    ipc.config.id = '-child-'+cluster.worker.id;
    var cast = null;

    ipc.serve(function(){
        ipc.server.on('message', function(data, socket){
            var action = data.action;
            var options = data.options;
            debug('child-', cluster.worker.id, 'processing', action, '(', options, ')');

            if(cast === null){
                castCentral.discover(castCentral[options.protocol.toUpperCase()], options.search, function(casts){
                    debug(casts);
                    if(action === 'list'){
                        ipc.server.emit(socket, 'message', casts);
                        return;
                    }else{
                        // All other actions require a specific cast
                        for(c in casts){
                            if(casts[c].name !== options.name){ continue; }
                            cast = casts[c];

                            process.send({
                                alive: true,
                                id: cluster.worker.id,
                                cast: cast.name
                            });

                            break;
                        }

                        processAction(cast, action, options, socket);
                    }
                });
            }else{
                processAction(cast, action, options, socket);
            }
        }); // on 'message'
    }); // serve

    ipc.server.start();
}

function workerExit(worker){
    debug('child-', worker.id, 'exiting');
    process.send({
        alive: false,
        id: worker.id
    });
    worker.kill();
}

function jsonWorkers(workers){
    var jsons = [];

    for(worker in workers){
        jsons.push(workers[worker].id);
    }

    return jsons;
}

function processAction(cast, action, options, socket){
    // Figure out what action to perform
    switch(action){
    case 'launch':
        cast.launch(options.app, function(){
            ipc.server.emit(socket, 'message', true);
        });
        break;
    case 'load':
        cast.load(options.media, null, function(err){
            ipc.server.emit(socket, 'message', err || true);
        });
        break;
    case 'stop':
        cast.stop(function(){
            ipc.server.emit(socket, 'message', true);
            workerExit(cluster.worker);
        });
        break;
    case 'seek':
        cast.seek(options.amount, function(){
            ipc.server.emit(socket, 'message', true);
        });
        break;
    case 'mute':
        cast.setMute(options.mute, function(){
            ipc.server.emit(socket, 'message', true);
        });
        break;
    case 'volume':
        cast.setVolume(options.volume, function(){
            ipc.server.emit(socket, 'message', true);
        });
        break;
    default:
        ipc.server.emit(socket, 'message', 'invalid action');
    }
}
