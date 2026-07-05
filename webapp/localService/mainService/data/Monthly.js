/*
 * fe-mockserver 커스텀 핸들러 — Monthly(월간 실적) 생성/수정 자동 계산 (데모).
 * ui5con2023 Booking 생성(항공편 선택→가격·날짜 자동 반영) 대응:
 * 매출기간 VH 선택 + 매출/수금 입력 → 수금율·회전일·미수·신호등을 서버가 계산해 채운다.
 * (신규 단건 기준 단순식: 수금율=수금/매출, 미수=매출-수금. 시계열 롤포워드는 실 CDS에서.)
 */
'use strict';

const round1 = (n) => Math.round(n * 10) / 10;

function recompute(data) {
    // 매출기준일(달력 선택) → 매출기간(YYYY-MM) 자동 도출 (ui5con2023 항공편 선택→운항일 반영 대응)
    if (data.SalesPeriodDate) {
        data.FiscalPeriod = String(data.SalesPeriodDate).slice(0, 7);
    }
    const sales = Number(data.TotalMonthlySales || 0);
    const coll = Number(data.TotalMonthlyCollection || 0);
    if (sales > 0) {
        const eom = Math.max(sales - coll, 0);
        data.EndOfMonthBal = eom;
        data.CurrentOutBalance = eom;
        data.RecoveryRate = round1(Math.min((coll / sales) * 100, 100));
        data.RotationDays = round1(eom / (sales / 30));
        data.Critical = data.RecoveryRate >= 75 ? 3 : data.RecoveryRate >= 60 ? 2 : 1;
    }
    if (!data.CurrencyCode) {
        data.CurrencyCode = 'KRW';
    }
    return data;
}

module.exports = {
    async onBeforeAddEntry(keyValues, data, odataRequest) {
        // 신규 생성행: 키가 비어 있으면 대리점ID+기간(없으면 타임스탬프)으로 생성
        if (!data.CustomerMonthlyUuid) {
            data.CustomerMonthlyUuid = (data.CustomerId || 'NEW') + '-' + (data.FiscalPeriod || Date.now());
        }
        recompute(data);
    },

    async onBeforeUpdateEntry(keyValues, updatedData, odataRequest) {
        recompute(updatedData);
    }
};
