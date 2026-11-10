import { AddAccountWizard } from "./AddAccountWizard";
import { MailCompose } from "./MailCompose";
import { MailList } from "./MailList";
import { useMail } from "./MailProvider";
import { MailReader } from "./MailReader";
import { Spinner } from "../ui/Spinner";
import "./mail.css";

export function MailPage() {
  const { screen, accounts, accountsLoaded, compose, wizardAccount, completeWizard, closeWizard } =
    useMail();

  if (!accountsLoaded) {
    return (
      <div className="mc-mail__page">
        <div className="mc-mail__center">
          <Spinner />
        </div>
      </div>
    );
  }

  return (
    <div className="mc-mail__page">
      <div className="mc-mail__layer" data-hidden={screen !== "list"}>
        <MailList />
      </div>
      {screen === "reader" ? (
        <div className="mc-mail__layer">
          <MailReader />
        </div>
      ) : null}
      {screen === "compose" && compose ? (
        <div className="mc-mail__layer">
          <MailCompose
            key={`${compose.mode}:${compose.draft?.id ?? compose.body?.uid ?? "new"}`}
          />
        </div>
      ) : null}
      {screen === "wizard" ? (
        <div className="mc-mail__layer">
          <AddAccountWizard
            account={wizardAccount}
            allowCancel={accounts.length > 0}
            onComplete={(accountId) => void completeWizard(accountId)}
            onCancel={closeWizard}
          />
        </div>
      ) : null}
    </div>
  );
}
