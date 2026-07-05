/*
 * 대리점 매출 현황 — 목업 데이터 생성기 (로직 기반, 자연스러운 정합 데이터)
 *
 * 설계 원칙: 하드코딩 대신 로직화. 대리점별 프로필(여신한도 L·매출규모·소득 소진율 경로)에서
 * 월별 데이터를 "미수 롤포워드"로 생성하고, root(여신잔액·미수·점유율·Critical·추세)를
 * 마지막 달에서 도출 → root와 monthly, 매출/수금/미수/수금율/회전일이 전부 일관되게 맞물린다.
 *
 * 핵심 관계식 (대리점 여신·매출 관리 표준):
 *   월말미수(EOMₜ)      = 전월미수(EOMₜ₋₁) + 당월매출(Salesₜ) − 당월수금(Collectionₜ)
 *   수금율(Recoveryₜ)   = 당월수금 / (전월미수 + 당월매출) × 100      (회수대상 대비 수금, 자연히 ≤100)
 *   회전일(Rotationₜ)   = 월말미수 / (당월매출 / 30)                   (미수 회전일수)
 *   현여신잔액(root)    = 월말미수 + 미착(출고~청구 중, ≈ 당월매출×12%), 한도 L 이내
 *   여신점유율          = 현여신잔액 / 한도 × 100
 *   Critical(신호등)    = 점유율 ≥80%→1(위험/빨강), 60~80%→2(주의/노랑), <60%→3(양호/초록)
 *
 * 실행: node generate-agency-mock.js → webapp/localService/mainService/data/{Agency,Monthly}.json
 */
'use strict';
const fs = require('fs');
const path = require('path');

const round1 = (n) => Math.round(n * 10) / 10;
const roundMan = (n) => Math.round(n / 10000) * 10000; // 만원 단위 반올림(자연스러운 자릿수)
const period = (yyyymm) => yyyymm.slice(0, 4) + '-' + yyyymm.slice(4, 6);
const PERIODS = ['202404', '202405', '202406', '202407', '202408', '202409', '202410'];
const SEASONAL = [0.85, 1.00, 1.10, 0.95, 1.05, 1.15, 0.90]; // 월별 매출 계절성

// 점유율(여신소진율) → 신호등
function occCritical(occ) { return occ >= 80 ? 1 : occ >= 60 ? 2 : 3; }
// 수금율 → 신호등 (높을수록 양호). 수금율 = 수금/(전월미수+당월매출)이라 이월미수 때문에 자연히 55~80%대에 분포.
function recoveryCritical(rec) { return rec >= 75 ? 3 : rec >= 60 ? 2 : 1; }

// 거래상태 (ui5con2023 TravelStatus 대응): A 활성 / H 보류 / C 해지, 신호등 3/2/1
const STATUS_META = { A: { name: '활성', crit: 3 }, H: { name: '보류', crit: 2 }, C: { name: '해지', crit: 1 } };

// 고객유형 아이콘 (ui5con2023 AirlinePic 대응 — UI.IsImageURL, sap-icon URI는 FE Avatar가 아이콘으로 렌더)
const TYPE_ICON = {
    '일반대리점': 'sap-icon://retail-store',
    '대형수퍼': 'sap-icon://building',
    '중형수퍼': 'sap-icon://cart',
    '소형수퍼': 'sap-icon://cart-4'
};

// ---- 대리점 마스터 프로필 (root 서술필드 + 여신한도 L + 담보 + 매출·소진율 프로필) ----
// L: 여신한도, coll: 담보현황, salesMult: 월평균매출/한도 배수, occStart: 기초 소진율, occPath[7]: 월말 소진율 경로
const AGENCIES = [
    { id: '1001213', name: '맛있는식품A', rep: '김상일', start: '2022-12-01', ctype: '일반대리점', stype: '대리점', srep: '이선영', dept: '3영업부_3영업2지점', center: '광주물류', addr: '경기도 광명시 가학동 102-3', colType: '보증보험', colAmt: 100000000, status: 'A',
      L: 1000000000, coll: 931150000, salesMult: 1.6, occStart: 0.48, occPath: [0.52, 0.58, 0.64, 0.61, 0.68, 0.74, 0.72] },
    { id: '1002079', name: '(주)도강오티지', rep: '김태후', start: '2018-06-25', ctype: '일반대리점', stype: '대리점', srep: '조진우', dept: '4영업부_인천1지점', center: '화성물류', addr: '인천광역시 서구 봉수대로 501번길 19', colType: '품의여신', colAmt: 700000000, status: 'A',
      L: 800000000, coll: 620000000, salesMult: 1.4, occStart: 0.55, occPath: [0.58, 0.61, 0.63, 0.60, 0.62, 0.65, 0.62] },
    { id: '1119643', name: '(주)일조', rep: '이주성', start: '2017-04-25', ctype: '중형수퍼', stype: '법인', srep: '강기훈', dept: '2영업부_2영업3지점', center: '화성물류', addr: '경기도 의정부시 동일로 663', colType: '보증보험', colAmt: 80000000, status: 'H',
      L: 100000000, coll: 87525000, salesMult: 1.3, occStart: 0.40, occPath: [0.44, 0.49, 0.45, 0.51, 0.47, 0.43, 0.46] },
    { id: '1210121', name: '원마트', rep: '이수민', start: '2022-09-01', ctype: '일반대리점', stype: '대리점', srep: '이선영', dept: '3영업부_3영업2지점', center: '광주물류', addr: '경기도 광명시 가학동 118-5', colType: '보증보험', colAmt: 500000000, status: 'A',
      L: 700000000, coll: 560000000, salesMult: 1.5, occStart: 0.50, occPath: [0.53, 0.56, 0.59, 0.55, 0.57, 0.58, 0.56] },
    { id: '1305312', name: '이지엠에스케이마트', rep: '박명숙', start: '2017-01-10', ctype: '대형수퍼', stype: '법인', srep: '이승헌', dept: '4영업부_인천2지점', center: '양주물류', addr: '인천광역시 계양구 봉오대로 581', colType: '보증보험', colAmt: 300000000, status: 'C',
      L: 1000000000, coll: 946100000, salesMult: 1.2, occStart: 0.72, occPath: [0.76, 0.79, 0.81, 0.83, 0.84, 0.85, 0.86] },
    { id: '1315134', name: '리더스식자재할인마트', rep: '임정호', start: '2015-05-20', ctype: '소형수퍼', stype: '슈퍼', srep: '이충희', dept: '경북영업부_구미지점', center: '양주물류', addr: '경상북도 영주시 선비로 223', colType: '현금', colAmt: 100000000, status: 'A',
      L: 900000000, coll: 820000000, salesMult: 1.7, occStart: 0.55, occPath: [0.59, 0.63, 0.67, 0.64, 0.68, 0.71, 0.69] }
];

// 대리점별 월별 시계열 생성 (미수 롤포워드)
function buildMonthly(a) {
    const rows = [];
    let prevEom = roundMan(a.L * a.occStart);
    for (let t = 0; t < PERIODS.length; t++) {
        const sales = roundMan(a.L * a.salesMult * SEASONAL[t]);
        const eom = roundMan(a.L * a.occPath[t]);
        let collection = prevEom + sales - eom;              // 롤포워드에서 역산한 당월수금
        if (collection < 0) { collection = 0; }
        const base = prevEom + sales;                        // 회수대상 = 전월미수 + 당월매출
        const recovery = base > 0 ? round1((collection / base) * 100) : 0;
        const rotation = sales > 0 ? round1(eom / (sales / 30)) : 0;
        rows.push({
            period: PERIODS[t], sales, collection, outbal: eom, eom, rotation, recovery,
            crit: recoveryCritical(recovery)
        });
        prevEom = eom;
    }
    return rows;
}

const agencyRows = [];
const monthlyRows = [];

AGENCIES.forEach((a) => {
    const months = buildMonthly(a);
    const last = months[months.length - 1];
    const prev = months[months.length - 2];
    const inTransit = roundMan(a.L * 0.06);                  // 미착(출고~청구 중): 한도의 6% 수준 버퍼
    const creditBal = Math.min(last.eom + inTransit, a.L);   // 현여신잔액 = 미수 + 미착 (한도 이내)
    const prevCreditBal = Math.min(prev.eom + inTransit, a.L);
    const occupancy = round1((creditBal / a.L) * 100);
    const st = STATUS_META[a.status];

    agencyRows.push({
        CustomerId: a.id,
        CustomerName: a.name,
        RepresentativeName: a.rep,
        StartDate: a.start,
        CustomerTypeName: a.ctype,
        SalesTypeName: a.stype,
        SalesRepName: a.srep,
        SalesRepDepartmentName: a.dept,
        LogisticsCenter: a.center,
        Address: a.addr,
        CurrentCreditBal: creditBal,
        TotalCreditLimit: a.L,
        CurrentCollateral: a.coll,
        EndOfMonthBal: last.eom,
        OccupancyLevel: occupancy,
        CollateralType: a.colType,
        CollateralAmount: a.colAmt,
        Critical: occCritical(occupancy),
        CreditBalTrend: creditBal > prevCreditBal ? 1 : creditBal < prevCreditBal ? -1 : 0,
        CreditBalPrevMonth: prevCreditBal,
        AgencyStatus: a.status,
        AgencyStatusName: st.name,
        AgencyStatusCriticality: st.crit,
        ReviewRequired: occupancy >= 85,   // 여신 소진율 85%↑는 재심사 대상 기본 표시
        IsApproved: a.status === 'A',      // 대리점 상태 스위치(켬=승인/끔=보류)
        IsNotTerminated: a.status !== 'C', // 거래 해지 액션 활성화 조건(해지 전만 실행 가능)
        IconUrl: TYPE_ICON[a.ctype] || 'sap-icon://retail-store',
        CurrencyCode: 'KRW',
        IsActiveEntity: true,
        HasActiveEntity: false,
        HasDraftEntity: false
    });

    months.forEach((m) => {
        monthlyRows.push({
            CustomerMonthlyUuid: a.id + '-' + m.period,
            CustomerId: a.id,
            FiscalPeriod: period(m.period),
            SalesPeriodDate: period(m.period) + '-01', // 매출기준일(달력 필드) — 기간의 1일

            TotalMonthlySales: m.sales,
            TotalMonthlyCollection: m.collection,
            CurrentOutBalance: m.outbal,
            EndOfMonthBal: m.eom,
            RotationDays: m.rotation,
            RecoveryRate: m.recovery,
            Critical: m.crit,
            CurrencyCode: 'KRW',
            IsActiveEntity: true,
            HasActiveEntity: false,
            HasDraftEntity: false
        });
    });
});

// ---- 값 도움말(VH) 데이터: 마스터에서 파생(고정목록) + 기간 목록(기존 7개월 + 신규 등록용 미래 월) ----
const statusVhRows = Object.keys(STATUS_META).map((c) => ({ Code: c, Name: STATUS_META[c].name }));
const customerTypeVhRows = [...new Set(AGENCIES.map((a) => a.ctype))].sort().map((n) => ({ Name: n }));
const salesRepVhRows = [...new Map(AGENCIES.map((a) => [a.srep, { Name: a.srep, Department: a.dept }])).values()]
    .sort((a, b) => (a.Name < b.Name ? -1 : 1));
const VH_PERIODS = PERIODS.concat(['202411', '202412', '202501', '202502']);
const periodVhRows = VH_PERIODS.map((p) => ({
    FiscalPeriod: period(p),
    PeriodName: p.slice(0, 4) + '년 ' + Number(p.slice(4, 6)) + '월'
}));

const outDir = path.join(__dirname, '..', 'webapp', 'localService', 'mainService', 'data');
fs.writeFileSync(path.join(outDir, 'Agency.json'), JSON.stringify(agencyRows, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'Monthly.json'), JSON.stringify(monthlyRows, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'StatusVH.json'), JSON.stringify(statusVhRows, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'CustomerTypeVH.json'), JSON.stringify(customerTypeVhRows, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'SalesRepVH.json'), JSON.stringify(salesRepVhRows, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'PeriodVH.json'), JSON.stringify(periodVhRows, null, 2) + '\n');

console.log('Generated:', agencyRows.length, 'agencies /', monthlyRows.length, 'monthly rows');
agencyRows.forEach((a) => console.log(
    `  ${a.CustomerId} ${a.CustomerName} [${a.AgencyStatusName}]: 여신 ${(a.CurrentCreditBal / 1e8).toFixed(1)}억 / 한도 ${(a.TotalCreditLimit / 1e8).toFixed(1)}억`
    + ` · 점유율 ${a.OccupancyLevel}% · crit ${a.Critical} · 추세 ${a.CreditBalTrend > 0 ? '▲' : a.CreditBalTrend < 0 ? '▼' : '−'}`
));
