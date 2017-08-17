import {Messaging} from '../Messaging';

afterEach(async () => {
    await Promise.all(Messaging.instances.map(i => i.close(true)));
});