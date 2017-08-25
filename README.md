# Micromessaging [WIP 3.0.0]
[![Build Status](https://travis-ci.org/swanest/micromessaging.svg?branch=v3)](https://travis-ci.org/swanest/micromessaging)
[![codecov](https://codecov.io/gh/swanest/micromessaging/branch/master/graph/badge.svg)](https://codecov.io/gh/swanest/micromessaging)

This module has been written for Swanest back-end. It eases the use of messaging between services.
We use RabbitMQ as the underlying broker service.
This library is using amqplib (0.9.1) as a core dependency but we do use some parameters that are only RabbitMQ related so it might not work with other AMQP 0.9.1 brokers. 

----------


## Installation

`npm install micromessaging --save`

## API

Full API documentation is at: [swanest.github.com/micromessaging](https://swanest.github.com/micromessaging)

Special thanks to [TypeDoc](http://typedoc.org/) that enabled it.

## Dependencies

Just install RabbitMQ locally to develop (version must be > 3.3.0)

## Notes

v3.0 is going to have quite some breaking changes and CANT be used with an other module using an earlier version.

About what it does:
*  RPC model (`.request` / `.handle`)
*  Event subscription (PUB/SUB) (`.emit` / `.listen`)
*  Worker queue tasks (`.task` / `.handle`)
*  Election of a master between services that do have the same `serviceName` (in `new Messaging(serviceName[, serviceOptions])`)
*  Manage the process quality of service (`Qos.ts`)
   *  The QoS is managed through usage of `HeavyEL` for event-loop management and the `MemoryPressure` module to know about memory usage and pressure.
   *  What it basically does is to try to keep the process under a certain usage and will stop accepting messages when it reaches a certain threshold to avoid crashes. The reason is that this enables parallelism and it should be properly managed as NodeJS is single threaded.
*  Has knowledge about the status of it's peers (through `PeerStatus.ts`)

For the full API, `yarn docs` and open `docs/index.html` in your browser. The docs are not full yet.
The only API that should be exposed should rely on `Messaging.ts` class even though it might expose some underlying processes.

## TODO

* [x] Manage timeouts in requests.
* [x] `getStatus` of a service (to know if the service is accepting workload)
* [ ] Make API names consistent
* [x] Expose only Messaging so that other modules can do `new require('micromessaging').Messaging(...)` and `new require('micromessaging').Service(...)` (to ease backward compatibility but `Service` should log a warning to tell it's deprecated...)
* [ ] Go to the old codebase (within the dir) and check we didn't forgot a working behaviour or features.
* [ ] Quadruple check that everything works fine through some good testing!
* [ ] Delete old JS codebase
* [ ] Add more comments so that `typedoc` generates a cool and easy doc.
* [x] Travis auto tests
* [x] Publish a doc under GitHub pages => will be under swanest.github.com/micromessaging
* [x] Implement `.stop()` on the return of `emit` and `handle` => see ReturnHandler.

## Useful info

As we are transitioning to a new version, all relevant files will be under `src/` folder but
to ease work, we kept the old JS codebase so that we can easily sneak peak information in it about the old working procedures to not forget anything.
