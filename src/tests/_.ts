import { Messaging } from '../Messaging';

afterEach(async function () {
    this.timeout(5000);
    await Promise.all(Messaging.instances.map(i => i.close(true, true)));
    global.gc();
});
