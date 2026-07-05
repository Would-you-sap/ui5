/*
 * fe-mockserver 커스텀 핸들러 — Agency 엔티티의 바운드 액션 처리(데모).
 * 여신 승인/보류/해지 액션이 실제로 대리점의 거래상태(AgencyStatus + 신호등)를 변경한다.
 * FileBasedMockData 인스턴스에 메서드가 믹스인되므로 this.updateEntry / this.fetchEntries 사용 가능.
 */
'use strict';

const STATUS_BY_ACTION = {
    approveCredit: { AgencyStatus: 'A', AgencyStatusName: '활성', AgencyStatusCriticality: 3, IsApproved: true, IsNotTerminated: true },
    holdCredit: { AgencyStatus: 'H', AgencyStatusName: '보류', AgencyStatusCriticality: 2, IsApproved: false, IsNotTerminated: true },
    terminateAgency: { AgencyStatus: 'C', AgencyStatusName: '해지', AgencyStatusCriticality: 1, IsApproved: false, IsNotTerminated: false }
};

module.exports = {
    async executeAction(actionDefinition, actionData, keys, odataRequest) {
        const patch = STATUS_BY_ACTION[actionDefinition.name];
        if (patch) {
            await this.base.updateEntry(keys, patch, odataRequest);
        }
        const rows = await this.base.fetchEntries(keys, odataRequest);
        return rows && rows[0];
    }
};
