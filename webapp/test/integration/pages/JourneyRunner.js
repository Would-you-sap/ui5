sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"would/you/agency/test/integration/pages/FactoryMain"
], function (JourneyRunner, FactoryMain) {
    'use strict';

    var runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('would/you/agency') + '/test/flpSandbox.html#agency-tile',
        pages: {
			onTheFactoryMain: FactoryMain
        },
        async: true
    });

    return runner;
});

