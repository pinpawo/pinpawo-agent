# Channel routing (retired)

The former Channel router and mention-driven dispatch have been removed. Channel
stores messages from Human and Pet Instance producers and publishes a live event;
it does not select recipients or dispatch a Pet. Each online Pet Instance has an independent Head that subscribes and decides
whether to respond or request a Host dispatch. See [Channel model](channel-model.md) and
[addressing and execution](channel-addressing-and-execution.md).
