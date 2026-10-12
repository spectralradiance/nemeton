import { Route, Switch } from 'wouter';
import { ScheduleProvider } from './data/schedule';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Shell } from './components/Shell';
import { UpdatePrompt } from './components/UpdatePrompt';
import { Lineup } from './screens/Lineup';
import { NotFound } from './screens/NotFound';
import { Schedule } from './screens/Schedule';
import { SessionDetail } from './screens/SessionDetail';
import { Settings } from './screens/Settings';
import { Updates } from './screens/Updates';
import { Plan } from './screens/Plan';
import { PlanProvider } from './data/plan';
import { Vendors } from './screens/Vendors';

export function App() {
  return (
    <>
      {/* Outside the provider so the service worker registers even before any schedule exists. */}
      <UpdatePrompt />
      <ScheduleProvider>
        <PlanProvider>
          <Shell>
            <ErrorBoundary>
              <Switch>
                <Route path="/" component={Schedule} />
                <Route path="/schedule/:date?" component={Schedule} />
                <Route path="/lineup" component={Lineup} />
                <Route path="/session/:id" component={SessionDetail} />
                <Route path="/plan" component={Plan} />
                <Route path="/updates" component={Updates} />
                <Route path="/vendors" component={Vendors} />
                <Route path="/settings" component={Settings} />
                <Route>
                  <NotFound />
                </Route>
              </Switch>
            </ErrorBoundary>
          </Shell>
        </PlanProvider>
      </ScheduleProvider>
    </>
  );
}
