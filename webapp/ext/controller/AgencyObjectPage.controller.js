sap.ui.define(
    [
        'sap/ui/core/mvc/ControllerExtension',
        'sap/ui/model/json/JSONModel',
        'sap/ui/core/Element',
        'sap/ui/core/Fragment',
        'sap/m/MessageBox'
    ],
    function (ControllerExtension, JSONModel, Element, Fragment, MessageBox) {
        'use strict';

        // 지연 렌더되는 커스텀 섹션 VizFrame(id 부분일치)에 viz 속성을 적용. 생성될 때까지 재시도.
        function applyVizProps(sIdPart, oProps) {
            var iAttempts = 0;
            var fnApply = function () {
                var oVizFrame = Element.registry.filter(function (oElement) {
                    return oElement.isA && oElement.isA('sap.viz.ui5.controls.VizFrame') &&
                        oElement.getId().indexOf(sIdPart) > -1;
                })[0];
                if (oVizFrame) {
                    oVizFrame.setVizProperties(oProps);
                } else if (iAttempts < 30) {
                    iAttempts++;
                    setTimeout(fnApply, 200);
                }
            };
            fnApply();
        }

        // 월별 매출↔수금 추이(라인) + 월간 매출 차트(컬럼) 두 커스텀 차트에 공통 속성 적용.
        function applyTrendViz() {
            var oCommon = {
                title: { visible: false },
                legend: { visible: true },
                valueAxis: { title: { visible: false } },
                categoryAxis: { title: { visible: false } },
                interaction: { selectability: { mode: 'none' } },
                // 데이터포인트 위 마우스 오버 시 기간 + 매출/수금 금액 툴팁 표시
                tooltip: { visible: true },
                // window를 전체 데이터로 고정 → 카테고리 가로 스크롤바 제거(전 기간 항상 표시)
                plotArea: { dataLabel: { visible: false }, window: { start: 'firstDataPoint', end: 'lastDataPoint' } }
            };
            applyVizProps('TrendChart', oCommon);
            applyVizProps('MonthlySalesColChart', oCommon);
        }

        // 선택 대리점의 월간 매출을 _Monthly 로 읽어 추이/Best·Worst 월용 'detail' JSONModel 구성.
        // Promise 반환 — 내비게이션 직후 컨텍스트 미확정으로 거부될 수 있어 호출측에서 재시도한다.
        function loadDetailData(oView, oBindingContext) {
            if (!oView || !oBindingContext) {
                return Promise.reject(new Error('no context'));
            }
            var oBinding = oBindingContext.getModel().bindList('_Monthly', oBindingContext, undefined, undefined, {
                $select: 'CustomerMonthlyUuid,FiscalPeriod,TotalMonthlySales,TotalMonthlyCollection,RecoveryRate,RotationDays,EndOfMonthBal,Critical'
            });
            return oBinding.requestContexts(0, 200).then(function (aContexts) {
                var aMonths = aContexts.map(function (c) {
                    var o = c.getObject();
                    return {
                        FiscalPeriod: o.FiscalPeriod,
                        TotalMonthlySales: Number(o.TotalMonthlySales),
                        TotalMonthlyCollection: Number(o.TotalMonthlyCollection),
                        RecoveryRate: Number(o.RecoveryRate),
                        RotationDays: Number(o.RotationDays),
                        EndOfMonthBal: Number(o.EndOfMonthBal),
                        Critical: Number(o.Critical)
                    };
                });
                var aTrend = aMonths.slice().sort(function (a, b) {
                    return a.FiscalPeriod < b.FiscalPeriod ? -1 : 1;
                });
                var aByRecovery = aMonths.slice().sort(function (a, b) {
                    return a.RecoveryRate - b.RecoveryRate;
                });
                oView.setModel(new JSONModel({
                    trend: aTrend,
                    worst: aByRecovery.slice(0, 3),
                    best: aByRecovery.slice().reverse().slice(0, 3)
                }), 'detail');
                applyTrendViz();
            });
        }

        return ControllerExtension.extend('would.you.agency.ext.controller.AgencyObjectPage', {
            // 컨텍스트가 실제로 바뀔 때만 detail 모델 재구성 (딥링크·FCL 행클릭·드래프트 전환·활성화 모두 커버).
            // 내비게이션 직후엔 컨텍스트가 아직 확정 전이라 요청이 거부될 수 있어 짧게 재시도한다.
            _loadDetailForCurrentContext: function () {
                var that = this;
                var oView = this.base.getView();
                var oCtx = oView && oView.getBindingContext();
                if (!oCtx || oCtx.getPath() === this._sLastDetailPath) {
                    return;
                }
                this._sLastDetailPath = oCtx.getPath();
                this._iDetailRetries = 0;
                var fnLoad = function () {
                    loadDetailData(oView, oView.getBindingContext()).then(function () {
                        that._attachMonthPopover(); // 차트 렌더 후 선택→팝오버 배선 (ex7 대응)
                    }).catch(function () {
                        if (that._iDetailRetries++ < 4) {
                            setTimeout(fnLoad, 700);
                        } else {
                            that._sLastDetailPath = null; // 포기 — 다음 컨텍스트 변경에서 다시 시도
                        }
                    });
                };
                fnLoad();
            },

            // ex7 대응: 월간 매출 차트 + 월별 매출·수금 추이 차트의 데이터포인트(월) 클릭 → 해당 월 실적 Popover.
            // 두 차트 모두 dimension '매출기간' + detail 모델을 쓰므로 동일 핸들러(_onMonthSelect) 재사용.
            // VizFrame은 지연 렌더되므로 생성될 때까지 재시도 후 selectData 1회 배선.
            _attachMonthPopover: function () {
                var that = this;
                ['MonthlySalesColChart', 'TrendChart'].forEach(function (sIdPart) {
                    var iAttempts = 0;
                    var fnAttach = function () {
                        var oViz = Element.registry.filter(function (oElement) {
                            return oElement.isA && oElement.isA('sap.viz.ui5.controls.VizFrame') &&
                                oElement.getId().indexOf(sIdPart) > -1;
                        })[0];
                        if (oViz) {
                            oViz.setVizProperties({ interaction: { selectability: { mode: 'single' } } });
                            if (!oViz.data('monthPopover')) {
                                oViz.data('monthPopover', 'attached');
                                oViz.attachSelectData(that._onMonthSelect, that);
                            }
                        } else if (iAttempts++ < 30) {
                            setTimeout(fnAttach, 200);
                        }
                    };
                    fnAttach();
                });
            },

            _onMonthSelect: function (oEvent) {
                var oViz = oEvent.getSource();
                var aData = oEvent.getParameter('data');
                var oSel = aData && aData[0] && aData[0].data;
                var sPeriod = oSel && oSel['매출기간'];
                if (!sPeriod) { return; }
                var oView = this.base.getView();
                var oDetail = oView.getModel('detail');
                var oRow = ((oDetail && oDetail.getData().trend) || []).filter(function (m) {
                    return m.FiscalPeriod === sPeriod;
                })[0];
                if (!oRow) { return; }
                oView.setModel(new JSONModel(oRow), 'month');
                if (!this._pMonthPopover) {
                    this._pMonthPopover = Fragment.load({
                        id: oView.getId(),
                        name: 'would.you.agency.ext.fragment.MonthPopover',
                        controller: this
                    }).then(function (oPopover) {
                        oView.addDependent(oPopover);
                        return oPopover;
                    });
                }
                this._pMonthPopover.then(function (oPopover) { oPopover.openBy(oViz); });
            },

            override: {
                onInit: function () {
                    // FCL 행클릭 내비게이션에서는 onAfterBinding 파라미터/시점이 어긋날 수 있어
                    // 뷰의 바인딩 컨텍스트 변경 이벤트로 항상 로딩을 보장한다.
                    var that = this;
                    this.base.getView().attachModelContextChange(function () {
                        that._loadDetailForCurrentContext();
                    });
                },
                routing: {
                    onAfterBinding: function (oBindingContext) {
                        this._loadDetailForCurrentContext();
                    }
                },
                editFlow: {
                    // 저장 전 처리:
                    // 1) '대리점 상태' 스위치(IsApproved) → 거래상태(A/H) 동기화. 해지(C)는 스위치 켬(승인)일 때만 A로 복귀.
                    // 2) ex8 방식 정합성 검증 — 여신한도가 담보를 초과했는데 '여신 재심사 필요' 미체크면 경고.
                    onBeforeSave: function (mParameters) {
                        var oContext = mParameters && mParameters.context;
                        if (!oContext) { return Promise.resolve(); }
                        var o = oContext.getObject();

                        var sNewStatus = o.IsApproved ? 'A' : (o.AgencyStatus === 'C' ? 'C' : 'H');
                        if (sNewStatus !== o.AgencyStatus) {
                            var mStatus = { A: { name: '활성', crit: 3 }, H: { name: '보류', crit: 2 }, C: { name: '해지', crit: 1 } }[sNewStatus];
                            oContext.setProperty('AgencyStatus', sNewStatus);
                            oContext.setProperty('AgencyStatusName', mStatus.name);
                            oContext.setProperty('AgencyStatusCriticality', mStatus.crit);
                            oContext.setProperty('IsNotTerminated', sNewStatus !== 'C');
                        }
                        var bOverLimit = Number(o.TotalCreditLimit) > Number(o.CurrentCollateral);
                        if (bOverLimit && !o.ReviewRequired) {
                            var SET = '재심사 체크 후 저장';
                            var KEEP = '그대로 저장';
                            return new Promise(function (resolve, reject) {
                                MessageBox.warning(
                                    '여신한도가 담보현황을 초과합니다. 여신 재심사 대상으로 표시하고 저장할까요?',
                                    {
                                        actions: [SET, KEEP, MessageBox.Action.CANCEL],
                                        emphasizedAction: SET,
                                        onClose: function (sAction) {
                                            if (sAction === MessageBox.Action.CANCEL || !sAction) {
                                                reject();
                                            } else if (sAction === SET) {
                                                oContext.setProperty('ReviewRequired', true).then(resolve, resolve);
                                            } else {
                                                resolve();
                                            }
                                        }
                                    }
                                );
                            });
                        }
                        return Promise.resolve();
                    }
                }
            }
        });
    }
);
