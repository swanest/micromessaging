# Micromessaging
[![Build Status](https://travis-ci.org/swanest/micromessaging.svg?branch=v3)](https://travis-ci.org/swanest/micromessaging)

This module has been written for Swanest back-end. It eases the use of messaging between services.
We use RabbitMQ as the underlying broker service.
This library is using amqplib (0.9.1) as a core dependency but we do use some parameters that are only RabbitMQ related so it might not work with other AMQP 0.9.1 brokers. 

----------


## Installation

`yarn add micromessaging`
`npm install micromessaging --save`

## API

Full API documentation is at: [swanest.github.io/micromessaging](https://swanest.github.io/micromessaging)

Special thanks to [TypeDoc](http://typedoc.org/) that enabled it.

## Dependencies

*  RabbitMQ > 3.3.0

## Usage

```typescript
import { Messaging } from 'micromessaging';

// Server
const server = new Messaging('server');
await server.handle('request-name', (message) => {
    // message.body = {how: {are: 'you?'}}
    message.reply({im: 'fine'});
});
await server.connect(); // Connect can be before or after the handlers it doesnt matter.


// Client
const client = new Messaging('client');
await client.connect(); // Connection needs to be established before...
const response = await client.request('server', 'request-name', {how: {are: 'you?'}});
// response = {im: 'fine'}
```

## Notes

v3.0 is a full breaking changes and CANT be used with an other modules using an earlier version.

About what it does:
*  RPC model (`.request` / `.handle`)
*  Event subscription (PUB/SUB) (`.emit` / `.listen`)
*  Worker queue tasks (`.task` / `.handle`)
*  Election of a master between services that do have the same `serviceName` (in `new Messaging(serviceName[, serviceOptions])`)
*  Manage the process quality of service (`Qos.ts`)
   *  The QoS is managed through usage of `HeavyEL` for event-loop management and the `MemoryPressure` module to know about memory usage and pressure.
   *  What it basically does is to try to keep the process under a certain usage and will stop accepting messages when it reaches a certain threshold to avoid crashes. The reason is that this enables parallelism and it should be properly managed as NodeJS is single threaded.
*  Has knowledge about the status of it's peers (through `PeerStatus.ts`)

## TODO

* [x] Manage timeouts in requests.
* [x] `getStatus` of a service (to know if the service is accepting workload)
* [x] Make API names consistent
* [x] Expose only Messaging so that other modules can do `new require('micromessaging').Messaging(...)` and `new require('micromessaging').Service(...)` (to ease backward compatibility but `Service` should log a warning to tell it's deprecated...)
* [ ] Go to the old codebase (within the dir) and check we didn't forgot a working behaviour or features.
* [ ] Quadruple check that everything works fine through some good testing!
* [ ] Delete old JS codebase
* [ ] Add more comments so that `typedoc` generates a cool and easy doc.
* [x] Travis auto tests
* [x] Publish a doc under GitHub pages => will be under swanest.github.io/micromessaging
* [x] Implement `.stop()` on the return of `emit` and `handle` => see ReturnHandler.
