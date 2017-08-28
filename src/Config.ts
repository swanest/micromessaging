export class Config {
    private globalParallelism: number = 500; // Channel level default prefetch. It overrules Q_REQUESTS.limit's consumer prefetch
    private timeoutToSubscribe: number = 60 * 1000;
    private discoverable: boolean = false;
    private memoryPressureHandled: boolean = false;
}