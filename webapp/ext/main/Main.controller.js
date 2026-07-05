sap.ui.define(
    [
        'sap/fe/core/PageController',
        'sap/ui/model/json/JSONModel',
        'sap/ui/core/Fragment'
    ],
    function (PageController, JSONModel, Fragment) {
        'use strict';

        // KRW 금액을 억/조 단위로 축약 (NumericContent value+scale)
        function formatCompact(value) {
            var abs = Math.abs(value);
            if (abs >= 1e12) { return { value: (value / 1e12).toFixed(1), scale: '조' }; }
            if (abs >= 1e8) { return { value: (value / 1e8).toFixed(1), scale: '억' }; }
            if (abs >= 1e4) { return { value: (value / 1e4).toFixed(0), scale: '만' }; }
            return { value: String(value), scale: '' };
        }

        // Critical(3/2/1) → NumericContent valueColor 신호등
        function criticalityToColor(c) {
            var n = Number(c);
            return n === 3 ? 'Good' : n === 2 ? 'Critical' : n === 1 ? 'Error' : 'Neutral';
        }

        return PageController.extend('would.you.agency.ext.main.Main', {
            // --- 상위 대리점 타일 포매터 (OData 필드 → 타일 표시) ---
            formatTileValue: function (v) { return formatCompact(Number(v)).value; },
            formatTileScale: function (v) { return formatCompact(Number(v)).scale; },
            formatTileColor: function (c) { return criticalityToColor(c); },
            formatTileIndicator: function (t) { var n = Number(t); return n > 0 ? 'Up' : n < 0 ? 'Down' : 'None'; },

            // 타일 클릭 → 해당 대리점 ObjectPage(FCL mid 컬럼)로 표준 FE 내비게이션
            onTilePress: function (oEvent) {
                var oContext = oEvent.getSource().getBindingContext();
                if (oContext) {
                    this.getExtensionAPI().routing.navigate(oContext);
                }
            },

            onAfterRendering: function () {
                this.byId('FilterBar').triggerSearch();
                if (!this._bKpiLoaded) {
                    this._bKpiLoaded = true;
                    this._loadKpi();
                    this._applyChartProperties();
                }
                this._attachOverviewPopover();
            },

            // 오버뷰 대리점 차트(여신 점유율 / 월말미수) 막대 클릭 → selectData 배선.
            _attachOverviewPopover: function () {
                if (this._bOverviewPopAttached) { return; }
                var that = this;
                var iTries = 0;
                var fnAttach = function () {
                    var oCredit = that.byId('ChartCredit');
                    var oRecv = that.byId('ChartReceivable');
                    if (oCredit && oRecv) {
                        [oCredit, oRecv].forEach(function (oViz) {
                            if (!oViz.data('agencyPopover')) {
                                oViz.data('agencyPopover', 'attached');
                                oViz.attachSelectData(that._onAgencyChartSelect, that);
                            }
                        });
                        that._bOverviewPopAttached = true;
                    } else if (iTries++ < 30) {
                        setTimeout(fnAttach, 300);
                    }
                };
                fnAttach();
            },

            // 오버뷰 대리점 차트 선택 → 해당 대리점 여신 상세 Popover.
            _onAgencyChartSelect: function (oEvent) {
                var oViz = oEvent.getSource();
                var aData = oEvent.getParameter('data');
                var oSel = aData && aData[0] && aData[0].data;
                var sAgency = oSel && oSel.Agency;
                if (!sAgency) { return; }
                var oKpi = this.getView().getModel('kpi');
                var oRow = ((oKpi && oKpi.getData().chart) || []).filter(function (a) { return a.CustomerName === sAgency; })[0];
                if (!oRow) { return; }
                this.getView().setModel(new JSONModel(oRow), 'agencyDetail');
                this._openPopover('AgencyChartPopover', 'would.you.agency.ext.fragment.AgencyChartPopover', oViz);
            },

            // Popover 지연 로드 + openBy (키별 캐시).
            _openPopover: function (sKey, sName, oOpenBy) {
                var oView = this.getView();
                this._pPopovers = this._pPopovers || {};
                if (!this._pPopovers[sKey]) {
                    this._pPopovers[sKey] = Fragment.load({ id: oView.getId() + '-' + sKey, name: sName, controller: this }).then(function (oPop) {
                        oView.addDependent(oPop);
                        return oPop;
                    });
                }
                this._pPopovers[sKey].then(function (oPop) { oPop.openBy(oOpenBy); });
            },

            // 전체 대리점을 읽어 KPI 합계 + 차트 데이터('kpi' JSONModel) 구성
            _loadKpi: function () {
                var oView = this.getView();
                oView.getModel().bindList('/Agency').requestContexts(0, 200).then(function (aContexts) {
                    var aAgencies = aContexts.map(function (c) { return c.getObject(); });
                    var oTotals = aAgencies.reduce(function (acc, a) {
                        acc.credit += Number(a.CurrentCreditBal);
                        acc.receivable += Number(a.EndOfMonthBal);
                        acc.limit += Number(a.TotalCreditLimit);
                        return acc;
                    }, { credit: 0, receivable: 0, limit: 0 });
                    oView.setModel(new JSONModel({
                        totalCredit: formatCompact(oTotals.credit),
                        totalReceivable: formatCompact(oTotals.receivable),
                        totalLimit: formatCompact(oTotals.limit),
                        agencyCount: String(aAgencies.length),
                        chart: aAgencies.map(function (a) {
                            return {
                                CustomerName: a.CustomerName,
                                CurrentCreditBal: Number(a.CurrentCreditBal),
                                TotalCreditLimit: Number(a.TotalCreditLimit),
                                EndOfMonthBal: Number(a.EndOfMonthBal),
                                OccupancyLevel: Number(a.OccupancyLevel)
                            };
                        })
                    }), 'kpi');
                });
            },

            // 여신잔액 차트: 여신점유율(소진율) 밴드로 색상 — 테이블/타일 Critical(점유율 기준)과 일관.
            // 80%↑ 위험(빨강) / 60~80% 주의(노랑) / 60%↓ 양호(초록)
            _applyChartProperties: function () {
                var oBase = {
                    title: { visible: false },
                    legend: { visible: false },
                    valueAxis: { title: { visible: false } },
                    categoryAxis: { title: { visible: false } },
                    // 막대 클릭 시 선택 → 대리점 여신 상세 Popover (selectData). 호버 시 값 툴팁.
                    interaction: { selectability: { mode: 'single' } },
                    tooltip: { visible: true },
                    // window를 전체 데이터로 고정 → 카테고리 가로 스크롤바 제거(전 대리점 항상 표시)
                    plotArea: { dataLabel: { visible: false }, dataPointSize: { min: 8 }, window: { start: 'firstDataPoint', end: 'lastDataPoint' } }
                };
                var oCredit = JSON.parse(JSON.stringify(oBase));
                oCredit.plotArea.dataPointStyle = {
                    rules: [
                        { dataContext: { Occupancy: { min: 80 } }, properties: { color: 'sapUiChartPaletteSemanticBad' }, displayName: '위험(80%↑)' },
                        { dataContext: { Occupancy: { min: 60, max: 80 } }, properties: { color: 'sapUiChartPaletteSemanticCritical' }, displayName: '주의(60~80%)' },
                        { dataContext: { Occupancy: { max: 60 } }, properties: { color: 'sapUiChartPaletteSemanticGood' }, displayName: '양호(60%↓)' }
                    ]
                };
                this.byId('ChartCredit').setVizProperties(oCredit);
                this.byId('ChartReceivable').setVizProperties(oBase);
            }
        });
    }
);
