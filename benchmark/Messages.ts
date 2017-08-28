export const ITEM = {
    "_id": "5890b292f8b4d200079474aa",
    "schemaName": "X_close_V1",
    "contents": {
        "iid": "xrate:USD:SEK",
        "date": "1999-01-07T17:00:00Z",
        "value": 7.896681,
        "from": "USD",
        "to": "SEK"
    },
    "source": "5890b09fde3a2f665be8e9ad",
    "hash": "lS/UyOS4sXrtEv+vdaeuqCV++Rs=",
    "insertedAt": "2017-01-31T15:51:46.355Z",
    "screened": {"date": "2017-07-31T08:34:21.750Z", "useful": true}
};
export const BIG_MESSAGE = [];
for (let i = 0; i < 10000; i++) {
    BIG_MESSAGE.push(ITEM);
}

export const MEDIUM_MESSAGE = [];
for (let i = 0; i < 50; i++) {
    BIG_MESSAGE.push(ITEM);
}
