/**
 * The three demo apps the ui-snapshot baseline covers. Each is a small
 * Creator (.ds) source in the same shape as packages/ui-react/test fixtures,
 * chosen to exercise different widget families: contacts (lookup + select +
 * date), call-logs (phone + datetime + number + textarea) and restaurants
 * (decimal + url + a not-yet-generated page route).
 *
 * Canned endpoint rows use example.com addresses and short display strings so
 * the committed snapshots stay clear of the hygiene gate (no real emails, no
 * long digit runs). Dates are plain calendar strings; the report/detail views
 * render cell text verbatim (formatValue), so no timezone conversion can move
 * them.
 */

export const CONTACTS_DS = `application "Contacts"
{
	form New_Contact
	{
		displayname = "New Contact"
		must have Full_Name
		(
			type = text
			displayname = "Full Name"
		)
		Email
		(
			type = email
			displayname = "Email"
		)
		Kind
		(
			type = picklist
			displayname = "Kind"
			values = {"Friend","Work"}
		)
		Birthday
		(
			type = date
		)
		Owner_Ref
		(
			type = list
			values = Person.Name
		)
		actions
		{
			on add
			{
				submit
				(
					type = submit
					displayname = "Save"
				)
			}
		}
	}
	form Person
	{
		Name
		(
			type = text
		)
	}
	list All_Contacts
	{
		displayname = "All Contacts"
		show all rows from New_Contact
		(
			Full_Name
			Email
			Kind
			Birthday
			Owner_Ref
		)
		detailview
		(
			layout
			(
				datablock1
				(
					title = "Overview"
					fields
					(
						Full_Name
						Email
					)
				)
			)
		)
	}
}
`;

export const CALL_LOGS_DS = `application "Call Logs"
{
	form Log_Call
	{
		displayname = "Log a Call"
		must have Subject
		(
			type = text
			displayname = "Subject"
		)
		Direction
		(
			type = dropdown
			displayname = "Direction"
			values = {"Inbound","Outbound"}
		)
		Caller
		(
			type = phone
			displayname = "Caller"
		)
		Started_At
		(
			type = date-time
			displayname = "Started At"
		)
		Duration_Min
		(
			type = number
			displayname = "Duration (min)"
		)
		Notes
		(
			type = multi-line
			displayname = "Notes"
		)
		actions
		{
			on add
			{
				submit
				(
					type = submit
					displayname = "Log Call"
				)
			}
		}
	}
	list Recent_Calls
	{
		displayname = "Recent Calls"
		show all rows from Log_Call
		(
			Subject
			Direction
			Caller
			Started_At
			Duration_Min
		)
		detailview
		(
			layout
			(
				datablock1
				(
					title = "Overview"
					fields
					(
						Subject
						Caller
					)
				)
			)
		)
	}
}
`;

export const RESTAURANTS_DS = `application "Restaurants"
{
	form Restaurant
	{
		displayname = "Restaurant"
		must have Name
		(
			type = text
			displayname = "Name"
		)
		Cuisine
		(
			type = picklist
			displayname = "Cuisine"
			values = {"Italian","Japanese","Mexican"}
		)
		Rating
		(
			type = decimal
			displayname = "Rating"
		)
		Website
		(
			type = url
			displayname = "Website"
		)
		actions
		{
			on add
			{
				submit
				(
					type = submit
					displayname = "Save"
				)
			}
		}
	}
	form Visit
	{
		displayname = "Visit"
		must have Restaurant
		(
			type = list
			values = Restaurant.Name
		)
		Visited_On
		(
			type = date
			displayname = "Visited On"
		)
	}
	list All_Restaurants
	{
		displayname = "All Restaurants"
		show all rows from Restaurant
		(
			Name
			Cuisine
			Rating
			Website
		)
		detailview
		(
			layout
			(
				datablock1
				(
					title = "Overview"
					fields
					(
						Name
						Cuisine
					)
				)
			)
		)
	}
	page Guide
	{
		displayname = "Dining Guide"
	}
}
`;

/**
 * One canned row per app for the list/detail states, keyed by report column.
 * Lookup cells stay unset: the endpoint shape for a lookup cell is the
 * server's business, and an unset cell renders the stable empty marker.
 */
export const ROWS = {
  contacts: [
    { ROWID: '1', Full_Name: 'Ada Lovelace', Email: 'ada@example.com', Kind: 'Work', Birthday: '1815-12-10' },
    { ROWID: '2', Full_Name: 'Alan Turing', Email: 'alan@example.com', Kind: 'Friend', Birthday: '1912-06-23' },
  ],
  'call-logs': [
    { ROWID: '1', Subject: 'Onboarding walkthrough', Direction: 'Outbound', Caller: '555-0100', Started_At: '2024-03-04 12:30', Duration_Min: '25' },
    { ROWID: '2', Subject: 'Support follow-up', Direction: 'Inbound', Caller: '555-0101', Started_At: '2024-03-05 09:15', Duration_Min: '10' },
  ],
  restaurants: [
    { ROWID: '1', Name: 'Osteria Verde', Cuisine: 'Italian', Rating: '4.5', Website: 'https://osteria.example.com' },
    { ROWID: '2', Name: 'Sushi Hana', Cuisine: 'Japanese', Rating: '4.8', Website: 'https://hana.example.com' },
  ],
};

export const APPS = [
  { name: 'contacts', ds: CONTACTS_DS },
  { name: 'call-logs', ds: CALL_LOGS_DS },
  { name: 'restaurants', ds: RESTAURANTS_DS },
];
