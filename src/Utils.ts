export class Utils {
    public static hrtimeToMS(time: [number, number]): number {
        return (time[0] * 1e9 + time[1]) / 1e6;
    }
}
